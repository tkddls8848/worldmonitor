import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import alliancesData from '../shared/world-alliances.json' with { type: 'json' };
import issuerData from '../shared/world-sanctions-issuers.json' with { type: 'json' };
import portClusters from './shared/country-port-clusters.json' with { type: 'json' };
import { combineSanctionSources, countOpenSanctionsPairs, countUkSanctionsPairs, countUnSanctionsPairs, SANCTION_SOURCE_URLS, ukCheckDue } from './_world-sanctions.mjs';
import { bankClaimPairs, tradeDependencePairs } from './_world-economic-pairs.mjs';
import { markActivated } from './_world-overview-io.mjs';
import { WORLD_OVERVIEW_KEYS } from '../shared/world-overview.js';
import { loadEnvFile, readCanonicalValue, runSeed } from './_seed-utils.mjs';

const USER_AGENT = 'WorldMonitor-Personal-Collect/1.0 (world-relations)';
const BIS_KEY = 'economic:bis-lbs:v1';
const COMTRADE_KEY = (iso2) => `comtrade:bilateral-hs4:${iso2}:v1`;
const unwrap = (value) => value && typeof value === 'object' && Object.hasOwn(value, 'data') ? value.data : value;
const errorText = (error) => String(error?.message || error || 'source failed').slice(0, 240);

async function download(fetchImpl, url, timeoutMs) {
  const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  if (!response.body) throw new Error('empty response body');
  return Readable.fromWeb(response.body);
}

async function sourceAttempt(fn) {
  const started = performance.now();
  try {
    const result = await fn();
    return { result, diag: { ok: true, rows: result.rows, ms: Math.round(performance.now() - started) } };
  } catch (error) {
    return { result: null, diag: { ok: false, rows: 0, ms: Math.round(performance.now() - started), error: errorText(error) } };
  }
}

export async function fetchWorldRelations({ fetchImpl, readValue, nowMs, deadlineAtMs }) {
  const priorValue = unwrap(await readValue(WORLD_OVERVIEW_KEYS.relations));
  const previous = priorValue?.sanctions || null;
  // The 280 s seeder deadline reserves 40 s after 150 s OpenSanctions + 90 s UK; UN (60 s) runs alongside them.
  const ukWeeklyDue = ukCheckDue(previous, nowMs, true);
  let ukPromise = ukWeeklyDue
    ? sourceAttempt(async () => countUkSanctionsPairs(await download(fetchImpl, SANCTION_SOURCE_URLS.uk, 90_000)))
    : null;
  const [osResult, unResult] = await Promise.all([
    sourceAttempt(async () => countOpenSanctionsPairs(await download(fetchImpl, SANCTION_SOURCE_URLS.opensanctions, 150_000), issuerData.rules)),
    sourceAttempt(async () => countUnSanctionsPairs(await download(fetchImpl, SANCTION_SOURCE_URLS.un, 60_000))),
  ]);
  const shouldFetchUk = ukCheckDue(previous, nowMs, osResult.diag.ok);
  if (shouldFetchUk && !ukPromise) ukPromise = sourceAttempt(async () => countUkSanctionsPairs(await download(fetchImpl, SANCTION_SOURCE_URLS.uk, 90_000)));
  const ukResult = ukPromise
    ? await ukPromise
    : { result: null, diag: { ok: true, skipped: true, rows: 0, ms: 0 } };
  let sanctions;
  try {
    sanctions = combineSanctionSources({ openSanctions: osResult.result, un: unResult.result, uk: ukResult.result, previous, nowMs });
  } catch (error) {
    if (!priorValue?.sanctions) throw error;
    sanctions = priorValue.sanctions;
  }

  const reports = [];
  for (const iso2 of Object.keys(portClusters).filter((key) => /^[A-Z]{2}$/.test(key)).sort()) {
    if (Date.now() >= deadlineAtMs) break;
    const value = unwrap(await readValue(COMTRADE_KEY(iso2)));
    if (value) reports.push({ iso2, products: Array.isArray(value.products) ? value.products : [] });
  }
  const bis = unwrap(await readValue(BIS_KEY));
  const trade = tradeDependencePairs(reports, 40);
  return {
    generatedAt: nowMs,
    alliances: alliancesData,
    sanctions,
    economic: {
      trade: trade.pairs,
      bankClaims: bankClaimPairs(bis?.data?.countries || bis?.countries || {}, 20),
      tradeAsOfYear: trade.asOfYear,
    },
    diagnostics: {
      opensanctions: osResult.diag,
      un: unResult.diag,
      uk: ukResult.diag,
    },
  };
}

export function declareRecords(data) {
  return (data?.alliances?.bilateral?.length || 0) + (data?.sanctions?.pairs?.length || 0)
    + (data?.economic?.trade?.length || 0) + (data?.economic?.bankClaims?.length || 0);
}

const isValidRelations = (data) => Array.isArray(data?.sanctions?.pairs) && (data?.alliances?.bilateral?.length || 0) > 0;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  loadEnvFile(import.meta.url);
  await runSeed('world-overview', 'relations', WORLD_OVERVIEW_KEYS.relations,
    ({ fetchDeadlineAtMs }) => fetchWorldRelations({ fetchImpl: (...args) => globalThis.fetch(...args), readValue: readCanonicalValue, nowMs: Date.now(), deadlineAtMs: fetchDeadlineAtMs }),
    { validateFn: isValidRelations, declareRecords, ttlSeconds: 345600, sourceVersion: 'world-relations-v1', schemaVersion: 1,
      maxStaleMin: 4320, lockTtlMs: 300_000, fetchPhaseTimeoutMs: 280_000,
      afterPublish: () => markActivated('seed-activated:world-overview:relations') });
}
