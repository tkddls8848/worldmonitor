#!/usr/bin/env node

import {
  acquireLockSafely,
  extendExistingTtl,
  getRedisCredentials,
  loadEnvFile,
  logSeedResult,
  releaseLock,
  verifySeedKey,
  withRetry,
} from './_seed-utils.mjs';
import {
  createCountryResolvers,
  isIso2,
  resolveIso2,
} from './_country-resolver.mjs';
import { isInRankableUniverse } from './shared/rankable-universe.mjs';

export { createCountryResolvers, resolveIso2 } from './_country-resolver.mjs';

loadEnvFile(import.meta.url);

export const COUNTRY_REFERENCE_INDEX_KEY = 'resilience:static:index:v1';
export const COUNTRY_REFERENCE_META_KEY = 'seed-meta:resilience:static';
export const COUNTRY_REFERENCE_PREFIX = 'resilience:static:';
export const COUNTRY_REFERENCE_TTL_SECONDS = 400 * 24 * 60 * 60;
// Preserve the previous source version so successful annual snapshots remain usable.
export const COUNTRY_REFERENCE_SOURCE_VERSION = 'resilience-static-v9';

const LOCK_DOMAIN = 'resilience:static';
const LOCK_TTL_MS = 2 * 60 * 60 * 1000;
const COUNTRY_DATASET_FIELDS = ['infrastructure', 'aquastat', 'iea'];
const INFRASTRUCTURE_INDICATORS = ['EG.ELC.ACCS.ZS'];
const WORLD_BANK_BASE = 'https://api.worldbank.org/v2';
const EUROSTAT_ENERGY_URL = 'https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data/nrg_ind_id?freq=A';
const WB_ENERGY_IMPORT_INDICATOR = 'EG.IMP.CONS.ZS';
const COUNTRY_RESOLVERS = createCountryResolvers();
const EUROSTAT_ENERGY_EU_MEMBER_FLOOR = 24;
const EUROSTAT_EU_MEMBER_ISO2 = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI',
  'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU',
  'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
]);

export function countryRedisKey(iso2) {
  return `${COUNTRY_REFERENCE_PREFIX}${iso2}`;
}

export function installSigtermLockCleanup({
  runId,
  processRef = process,
  release = releaseLock,
  logError = console.error,
} = {}) {
  if (!runId) throw new Error('installSigtermLockCleanup requires runId');

  const onSigterm = async () => {
    logError(`  [${LOCK_DOMAIN}] SIGTERM received — releasing lock runId=${runId}`);
    try {
      await release(LOCK_DOMAIN, runId);
    } catch (error) {
      logError(`  [${LOCK_DOMAIN}] SIGTERM cleanup error: ${error?.message || error}`);
    } finally {
      processRef.exit(143);
    }
  };

  processRef.once('SIGTERM', onSigterm);
  return () => processRef.off('SIGTERM', onSigterm);
}

function nowSeedYear(now = new Date()) {
  return now.getUTCFullYear();
}

export function shouldSkipSeedYear(meta, seedYear = nowSeedYear()) {
  return Boolean(
    meta
    && meta.status === 'ok'
    && meta.sourceVersion === COUNTRY_REFERENCE_SOURCE_VERSION
    && Number(meta.seedYear) === seedYear
    && !(meta.failedDatasets?.length > 0)
    && Number.isFinite(Number(meta.recordCount))
    && Number(meta.recordCount) > 0,
  );
}

function safeNum(value) {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function roundMetric(value, digits = 3) {
  const numeric = safeNum(value);
  if (numeric == null) return null;
  const factor = 10 ** digits;
  return Math.round(numeric * factor) / factor;
}

async function fetchJson(url, { timeoutMs = 30_000, accept = 'application/json' } = {}) {
  const response = await fetch(url, {
    headers: {
      Accept: accept,
      'User-Agent': 'WorldMonitor-Seed/1.0 (https://www.worldmonitor.app)',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function parseWorldBankPayload(raw, indicatorId) {
  if (!Array.isArray(raw) || raw.length < 2 || !Array.isArray(raw[1])) {
    throw new Error(`Unexpected World Bank response shape for ${indicatorId}`);
  }
  return {
    meta: raw[0] || {},
    rows: raw[1] || [],
  };
}

async function fetchWorldBankIndicatorRows(indicatorId, extraParams = {}) {
  const rows = [];
  let page = 1;
  let totalPages = 1;

  const MAX_WB_PAGES = 100;
  while (page <= totalPages && page <= MAX_WB_PAGES) {
    const params = new URLSearchParams({
      format: 'json',
      per_page: '1000',
      page: String(page),
      ...extraParams,
    });
    const url = `${WORLD_BANK_BASE}/country/all/indicator/${encodeURIComponent(indicatorId)}?${params}`;
    const raw = await withRetry(() => fetchJson(url), 2, 750);
    const parsed = parseWorldBankPayload(raw, indicatorId);
    totalPages = Number(parsed.meta.pages || 1);
    rows.push(...parsed.rows);
    page += 1;
  }

  return rows;
}

function selectLatestWorldBankByCountry(rows) {
  const latest = new Map();
  for (const row of rows) {
    const value = safeNum(row?.value);
    if (value == null) continue;
    const year = safeNum(row?.date);
    const iso2 = resolveIso2({
      iso3: row?.countryiso3code,
      name: row?.country?.value,
    });
    if (!iso2 || year == null) continue;
    const previous = latest.get(iso2);
    if (!previous || year > previous.year) {
      latest.set(iso2, {
        value: roundMetric(value),
        year,
        name: row?.country?.value || iso2,
      });
    }
  }
  return latest;
}

function upsertDatasetRecord(target, iso2, datasetField, value) {
  if (!value) return;
  const current = target.get(iso2) || {};
  current[datasetField] = value;
  target.set(iso2, current);
}

export async function fetchInfrastructureDataset() {
  const merged = new Map();
  const results = await Promise.allSettled(
    INFRASTRUCTURE_INDICATORS.map((indicatorId) =>
      fetchWorldBankIndicatorRows(indicatorId, { mrv: '12' })
        .then(selectLatestWorldBankByCountry)
        .then((countryMap) => ({ indicatorId, countryMap })),
    ),
  );

  let successfulIndicators = 0;
  for (const result of results) {
    if (result.status !== 'fulfilled') continue;
    successfulIndicators += 1;
    for (const [iso2, entry] of result.value.countryMap.entries()) {
      const current = merged.get(iso2) || {
        source: 'worldbank-infrastructure',
        indicators: {},
      };
      current.indicators[result.value.indicatorId] = {
        value: entry.value,
        year: entry.year,
      };
      merged.set(iso2, current);
    }
  }

  if (successfulIndicators === 0) {
    throw new Error('World Bank infrastructure: all indicator fetches failed');
  }

  return merged;
}

function reverseCategoryIndex(index = {}) {
  return Object.entries(index).reduce((acc, [label, position]) => {
    acc[position] = label;
    return acc;
  }, {});
}

function parseLatestEurostatValue(data, geoCode) {
  const dims = data?.dimension;
  const values = data?.value;
  if (!dims || !values) return null;

  const geoDim = dims.geo;
  const geoIndex = geoDim?.category?.index;
  if (!geoIndex || geoIndex[geoCode] === undefined) return null;

  const geoPos = geoIndex[geoCode];
  const timeIndexObj = dims.time?.category?.index;
  let latestYear = null;

  const dimOrder = data.id || [];
  const dimSizes = data.size || [];
  const strides = {};
  let stride = 1;
  for (let idx = dimOrder.length - 1; idx >= 0; idx -= 1) {
    strides[dimOrder[idx]] = stride;
    stride *= dimSizes[idx];
  }

  let latestValue = null;
  for (const key of Object.keys(values).sort((left, right) => Number(right) - Number(left))) {
    const rawValue = values[key];
    if (rawValue == null) continue;

    let remaining = Number(key);
    const coords = {};
    for (const dim of dimOrder) {
      const strideSize = strides[dim];
      const dimSize = dimSizes[dimOrder.indexOf(dim)];
      coords[dim] = Math.floor(remaining / strideSize) % dimSize;
      remaining %= strideSize;
    }

    if (coords.geo !== geoPos) continue;
    if (reverseCategoryIndex(dims.siec?.category?.index)[coords.siec] !== 'TOTAL') continue;

    latestValue = safeNum(rawValue);
    const matchedTime = Object.entries(timeIndexObj || {}).find(([, position]) => position === coords.time);
    latestYear = safeNum(matchedTime?.[0]);
    break;
  }

  if (latestValue == null || latestYear == null) return null;
  return {
    value: roundMetric(latestValue),
    year: latestYear,
  };
}

export function validateEurostatEnergyEuMemberFloor(parsed, floor = EUROSTAT_ENERGY_EU_MEMBER_FLOOR) {
  const euRows = [...EUROSTAT_EU_MEMBER_ISO2].filter((iso2) => parsed.has(iso2)).length;
  if (euRows < floor) {
    throw new Error(`Eurostat energy dependency parsed ${euRows} EU member rows (expected at least ${floor})`);
  }
  return { euRows, floor };
}

export function parseEurostatEnergyDataset(data, { enforceEuMemberFloor = false } = {}) {
  const ids = Array.isArray(data?.id) ? data.id : [];
  const dimensions = data?.dimension || {};
  if (!data?.value || !ids.length) {
    throw new Error('Eurostat dataset missing dimension metadata');
  }

  const parsed = new Map();
  const geoCodes = Object.keys(dimensions.geo?.category?.index || {});

  for (const iso2 of geoCodes) {
    if (!isIso2(iso2)) continue;
    const latest = parseLatestEurostatValue(data, iso2);
    if (!latest) continue;
    parsed.set(iso2, {
      source: 'eurostat-nrg_ind_id',
      energyImportDependency: {
        value: latest.value,
        year: latest.year,
        source: 'eurostat',
      },
    });
  }

  if (enforceEuMemberFloor) validateEurostatEnergyEuMemberFloor(parsed);
  return parsed;
}

export async function fetchEnergyDependencyDataset() {
  // Eurostat is the authoritative EU slice; if it is unavailable or collapses,
  // fail the whole iea adapter so recovery preserves the previous full snapshot.
  const [eurostatData, worldBankRows] = await Promise.all([
    withRetry(() => fetchJson(EUROSTAT_ENERGY_URL), 2, 750).catch((err) => {
      throw new Error(`Energy dependency: Eurostat fetch failed: ${err.message}`);
    }),
    fetchWorldBankIndicatorRows(WB_ENERGY_IMPORT_INDICATOR, { mrv: '12' }).catch(() => []),
  ]);

  let merged = new Map();
  try {
    merged = parseEurostatEnergyDataset(eurostatData, { enforceEuMemberFloor: true });
  } catch (err) {
    throw new Error(`Energy dependency: Eurostat parse/floor check failed: ${err.message}`);
  }
  const worldBankFallback = selectLatestWorldBankByCountry(worldBankRows);

  for (const [iso2, entry] of worldBankFallback.entries()) {
    if (merged.has(iso2)) continue;
    merged.set(iso2, {
      source: 'worldbank-energy-imports',
      energyImportDependency: {
        value: entry.value,
        year: entry.year,
        source: 'worldbank',
      },
    });
  }

  if (merged.size === 0) throw new Error('Energy dependency: both Eurostat and World Bank fallback failed');
  return merged;
}

const WB_WATER_STRESS_INDICATOR = 'ER.H2O.FWST.ZS';

export function buildAquastatWbMap(waterStressLatest) {
  const byCountry = new Map();
  for (const [iso2, entry] of waterStressLatest.entries()) {
    byCountry.set(iso2, {
      source: 'worldbank-aquastat',
      value: entry.value,
      indicator: 'water stress',
      year: entry.year,
    });
  }
  if (byCountry.size === 0) throw new Error('World Bank water stress returned no usable rows');
  return byCountry;
}

async function fetchAquastatDataset() {
  const rows = await fetchWorldBankIndicatorRows(WB_WATER_STRESS_INDICATOR, { mrv: '15' });
  const latest = selectLatestWorldBankByCountry(rows);
  return buildAquastatWbMap(latest);
}

export function finalizeCountryPayloads(datasetMaps, seedYear = nowSeedYear(), seededAt = new Date().toISOString()) {
  const merged = new Map();
  let droppedNonRankable = 0;

  for (const [datasetField, countryMap] of Object.entries(datasetMaps)) {
    for (const [iso2, payload] of countryMap.entries()) {
      if (!isInRankableUniverse(iso2)) {
        droppedNonRankable++;
        continue;
      }
      upsertDatasetRecord(merged, iso2, datasetField, payload);
    }
  }

  if (droppedNonRankable > 0) {
    console.log(`[country-reference] Dropped ${droppedNonRankable} non-rankable territory entries (filter: 193 UN members + 3 SARs)`);
  }

  for (const [iso2, payload] of merged.entries()) {
    const fullPayload = {};
    let availableDatasets = 0;
    for (const field of COUNTRY_DATASET_FIELDS) {
      const value = payload[field] ?? null;
      fullPayload[field] = value;
      if (value) availableDatasets += 1;
    }
    fullPayload.coverage = {
      availableDatasets,
      totalDatasets: COUNTRY_DATASET_FIELDS.length,
      ratio: roundMetric(availableDatasets / COUNTRY_DATASET_FIELDS.length, 3),
    };
    fullPayload.seedYear = seedYear;
    fullPayload.seededAt = seededAt;
    merged.set(iso2, fullPayload);
  }

  return merged;
}

function normalizeRecoveredDatasets(recoveredDatasets = {}) {
  return Object.entries(recoveredDatasets)
    .sort(([left], [right]) => left.localeCompare(right))
    .reduce((acc, [dataset, info]) => {
      acc[dataset] = {
        recordCount: Number(info?.recordCount) || 0,
        countries: [...(info?.countries ?? [])].sort(),
        seedYears: [...(info?.seedYears ?? [])].sort((left, right) => left - right),
        seededAts: [...(info?.seededAts ?? [])].sort(),
        sourceYears: [...(info?.sourceYears ?? [])].sort((left, right) => left - right),
      };
      return acc;
    }, {});
}

export function buildManifest(countryPayloads, failedDatasets, seedYear, seededAt, recoveredDatasets = {}) {
  const countries = [...countryPayloads.keys()].sort();
  return {
    countries,
    recordCount: countries.length,
    failedDatasets: [...failedDatasets].sort(),
    recoveredDatasets: normalizeRecoveredDatasets(recoveredDatasets),
    seedYear,
    seededAt,
    sourceVersion: COUNTRY_REFERENCE_SOURCE_VERSION,
  };
}

function buildMetaPayload({ status, recordCount, seedYear, failedDatasets, message = null }) {
  return {
    fetchedAt: Date.now(),
    recordCount,
    seedYear,
    failedDatasets: [...failedDatasets].sort(),
    status,
    sourceVersion: COUNTRY_REFERENCE_SOURCE_VERSION,
    message,
  };
}

export function buildFailureRefreshKeys(manifest) {
  const keys = new Set([COUNTRY_REFERENCE_INDEX_KEY, COUNTRY_REFERENCE_META_KEY]);
  for (const iso2 of manifest?.countries || []) {
    if (isIso2(iso2)) keys.add(countryRedisKey(iso2));
  }
  return [...keys];
}

function collectSourceYears(value, years = new Set()) {
  if (!value || typeof value !== 'object') return years;
  for (const [key, nested] of Object.entries(value)) {
    if (key === 'seedYear') continue;
    if (/year$/i.test(key) && typeof nested !== 'object') {
      const numeric = safeNum(nested);
      if (numeric != null && numeric >= 1900 && numeric <= 2100) years.add(numeric);
      continue;
    }
    collectSourceYears(nested, years);
  }
  return years;
}

function recoveredDatasetProvenance(dataset, countryPayload, datasetValue) {
  const seedYear = safeNum(countryPayload?.seedYear);
  const seededAt = typeof countryPayload?.seededAt === 'string' ? countryPayload.seededAt : null;
  const sourceYears = [...collectSourceYears(datasetValue)].sort((left, right) => left - right);
  return {
    dataset,
    ...(seedYear != null ? { seedYear } : {}),
    ...(seededAt ? { seededAt } : {}),
    ...(sourceYears.length ? { sourceYears } : {}),
  };
}

function annotateRecoveredDatasetValue(dataset, countryPayload, datasetValue) {
  if (!datasetValue || typeof datasetValue !== 'object' || Array.isArray(datasetValue)) return datasetValue;
  return {
    ...datasetValue,
    _recovered: recoveredDatasetProvenance(dataset, countryPayload, datasetValue),
  };
}

function noteRecoveredDataset(recoveredDatasets, dataset, iso2, countryPayload, datasetValue) {
  const provenance = recoveredDatasetProvenance(dataset, countryPayload, datasetValue);
  const info = recoveredDatasets[dataset] ?? {
    recordCount: 0,
    countries: new Set(),
    seedYears: new Set(),
    seededAts: new Set(),
    sourceYears: new Set(),
  };
  info.recordCount += 1;
  info.countries.add(iso2);
  if (provenance.seedYear != null) info.seedYears.add(provenance.seedYear);
  if (provenance.seededAt) info.seededAts.add(provenance.seededAt);
  for (const year of provenance.sourceYears ?? []) info.sourceYears.add(year);
  recoveredDatasets[dataset] = info;
}

async function redisPipeline(commands) {
  const { url, token } = getRedisCredentials();
  const response = await fetch(`${url}/pipeline`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Redis pipeline failed: HTTP ${response.status} — ${text.slice(0, 200)}`);
  }
  return response.json();
}

async function writeJsonKey(key, value, ttlSeconds) {
  return redisPipeline([['SET', key, JSON.stringify(value), 'EX', ttlSeconds]]);
}

async function readJsonKey(key) {
  return verifySeedKey(key);
}

/**
 * Build the aggregated `resilience:static:fao` payload from the per-country
 * FAO dataset map. Only includes countries that IPC lists as Phase 3+ — by
 * design, IPC's "global latest" CSV only publishes crisis cases, so absence
 * from this aggregate means "not an IPC-monitored crisis country" (consistent
 * with how scoreFoodWater() treats missing per-country fao data).
 *
 * Output shape matches backtest-resilience-outcomes.mjs::detectFoodCrisis:
 *   { countries: { [iso2]: { ipcPhase, phase, peopleInCrisis, year, source } },
 *     fetchedAt, source, count, seedYear }
 */
async function publishSuccess(countryPayloads, manifest, meta) {
  const commands = [];
  for (const [iso2, payload] of countryPayloads.entries()) {
    commands.push(['SET', countryRedisKey(iso2), JSON.stringify(payload), 'EX', COUNTRY_REFERENCE_TTL_SECONDS]);
  }
  commands.push(['SET', COUNTRY_REFERENCE_INDEX_KEY, JSON.stringify(manifest), 'EX', COUNTRY_REFERENCE_TTL_SECONDS]);
  commands.push(['SET', COUNTRY_REFERENCE_META_KEY, JSON.stringify(meta), 'EX', COUNTRY_REFERENCE_TTL_SECONDS]);
  const results = await redisPipeline(commands);
  const failures = results.filter(r => r?.error || r?.result === 'ERR');
  if (failures.length > 0) {
    throw new Error(`Redis pipeline: ${failures.length}/${commands.length} commands failed`);
  }
}

async function preservePreviousSnapshotOnFailure(failedDatasets, seedYear, message) {
  const previousManifest = await readJsonKey(COUNTRY_REFERENCE_INDEX_KEY);
  const previousMeta = await readJsonKey(COUNTRY_REFERENCE_META_KEY);
  const recordCount = safeNum(previousManifest?.recordCount ?? previousMeta?.recordCount) ?? 0;
  const refreshKeys = buildFailureRefreshKeys(previousManifest);
  await extendExistingTtl(refreshKeys, COUNTRY_REFERENCE_TTL_SECONDS);

  const failureMeta = buildMetaPayload({
    status: 'error',
    recordCount,
    seedYear,
    failedDatasets,
    message,
  });
  await writeJsonKey(COUNTRY_REFERENCE_META_KEY, failureMeta, COUNTRY_REFERENCE_TTL_SECONDS);
  return { previousManifest, failureMeta };
}

export async function fetchAllDatasetMaps() {
  const adapters = [
    { key: 'infrastructure', fetcher: fetchInfrastructureDataset },
    { key: 'aquastat', fetcher: fetchAquastatDataset },
    { key: 'iea', fetcher: fetchEnergyDependencyDataset },
  ];

  const results = await Promise.allSettled(adapters.map((adapter) => adapter.fetcher()));
  const datasetMaps = {};
  const failedDatasets = [];

  for (let idx = 0; idx < adapters.length; idx += 1) {
    const adapter = adapters[idx];
    const result = results[idx];
    if (result.status === 'fulfilled') {
      datasetMaps[adapter.key] = result.value;
    } else {
      datasetMaps[adapter.key] = new Map();
      failedDatasets.push(adapter.key);
      console.warn(`  ${adapter.key}: ${result.reason?.message || result.reason || 'unknown error'}`);
    }
  }

  return { datasetMaps, failedDatasets };
}

export async function recoverFailedDatasets(datasetMaps, failedDatasets, { readIndex, readPipeline }) {
  const recoveredDatasets = {};
  if (failedDatasets.length === 0) return { recoveredDatasets };

  let existingIndex;
  try {
    existingIndex = await readIndex();
  } catch (err) {
    throw new Error(`Dataset(s) (${failedDatasets.join(', ')}) failed and Redis index read also failed: ${err.message}`);
  }

  const existingCountries = existingIndex?.countries ?? [];
  if (existingCountries.length === 0) {
    console.warn(`  [fallback] dataset(s) failed (${failedDatasets.join(', ')}) — no prior snapshot to recover from`);
    return { recoveredDatasets };
  }

  let pipelineResults;
  try {
    pipelineResults = await readPipeline(existingCountries.map((iso2) => ['GET', countryRedisKey(iso2)]));
  } catch (err) {
    throw new Error(`Dataset(s) (${failedDatasets.join(', ')}) failed and Redis pipeline read also failed: ${err.message}`);
  }

  for (let i = 0; i < existingCountries.length; i++) {
    const iso2 = existingCountries[i];
    let existing = null;
    try { existing = JSON.parse(pipelineResults[i]?.result ?? 'null'); } catch { /* skip */ }
    if (!existing) continue;
    for (const key of failedDatasets) {
      if (existing[key] != null && datasetMaps[key] instanceof Map && !datasetMaps[key].has(iso2)) {
        datasetMaps[key].set(iso2, annotateRecoveredDatasetValue(key, existing, existing[key]));
        noteRecoveredDataset(recoveredDatasets, key, iso2, existing, existing[key]);
      }
    }
  }

  for (const key of failedDatasets) {
    console.warn(`  [fallback] dataset '${key}' failed — preserved ${datasetMaps[key].size} existing Redis records from prior snapshot`);
  }

  return { recoveredDatasets: normalizeRecoveredDatasets(recoveredDatasets) };
}

export async function seedCountryReference() {
  const seedYear = nowSeedYear();
  const existingMeta = await readJsonKey(COUNTRY_REFERENCE_META_KEY).catch(() => null);
  if (shouldSkipSeedYear(existingMeta, seedYear)) {
    console.log(`  country-reference: seedYear ${seedYear} already written, skipping`);
    return {
      skipped: true,
      seedYear,
      reason: 'already_seeded',
    };
  }

  const { datasetMaps, failedDatasets } = await fetchAllDatasetMaps();

  let recovery = { recoveredDatasets: {} };
  try {
    recovery = await recoverFailedDatasets(datasetMaps, failedDatasets, {
      readIndex: () => readJsonKey(COUNTRY_REFERENCE_INDEX_KEY),
      readPipeline: redisPipeline,
    });
  } catch (recoveryErr) {
    const failure = await preservePreviousSnapshotOnFailure(
      failedDatasets,
      seedYear,
      recoveryErr.message,
    );
    const error = new Error(recoveryErr.message);
    error.failure = failure;
    throw error;
  }

  const seededAt = new Date().toISOString();
  const countryPayloads = finalizeCountryPayloads(datasetMaps, seedYear, seededAt);
  const manifest = buildManifest(countryPayloads, failedDatasets, seedYear, seededAt, recovery?.recoveredDatasets ?? {});

  if (manifest.recordCount === 0) {
    const failure = await preservePreviousSnapshotOnFailure(
      failedDatasets,
      seedYear,
      'No datasets produced usable country rows',
    );
    const error = new Error('Country reference seed produced no country rows');
    error.failure = failure;
    throw error;
  }

  const meta = buildMetaPayload({
    status: 'ok',
    recordCount: manifest.recordCount,
    seedYear,
    failedDatasets,
  });

  await publishSuccess(countryPayloads, manifest, meta);
  return {
    skipped: false,
    manifest,
    meta,
  };
}

export async function main() {
  const startedAt = Date.now();
  const runId = `country-reference:${startedAt}`;
  const lock = await acquireLockSafely(LOCK_DOMAIN, runId, LOCK_TTL_MS, { label: LOCK_DOMAIN });
  if (lock.skipped) return;
  if (!lock.locked) {
    console.log('  country-reference: another seed run is already active');
    return;
  }

  const removeSigtermHandler = installSigtermLockCleanup({ runId });
  try {
    const result = await seedCountryReference();
    logSeedResult('resilience:static', result?.manifest?.recordCount ?? 0, Date.now() - startedAt, {
      skipped: Boolean(result?.skipped),
      seedYear: result?.seedYear ?? result?.manifest?.seedYear ?? nowSeedYear(),
      failedDatasets: result?.manifest?.failedDatasets ?? [],
    });
  } finally {
    await releaseLock(LOCK_DOMAIN, runId);
    removeSigtermHandler();
  }
}

if (process.argv[1]?.endsWith('seed-country-reference.mjs')) {
  main().catch((error) => {
    const cause = error?.cause ? ` (cause: ${error.cause.message || error.cause})` : '';
    console.error(`FATAL: ${error.message || error}${cause}`);
    process.exit(1);
  });
}
