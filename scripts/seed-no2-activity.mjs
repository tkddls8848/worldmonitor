#!/usr/bin/env node

// Builds the regional NO2 activity dataset from NASA OMI/Aura OMNO2d v004.
// A UTC day's cloud-screened tropospheric grid supplies all 199 regions.
// Series live in economic:no2-activity:series:v2:<id>; the dataset and its
// activation marker publish atomically through runSeed.
//
// Authenticated live probe: confirm the Earthdata bearer token is accepted by
// the CMR-advertised OPeNDAP service, and that .dds exposes the Float32
// ColumnAmountNO2TropCloudScreened field (HDFEOS/GRIDS/ColumnAmountNO2/Data
// Fields) and .dods returns only that field in DAP2/XDR. Check the matching
// v004 granule metadata for 720 latitudes and 1440 longitudes, starting at
// 89.875 S and 179.875 W and increasing, and confirm the fill value
// (-1.2676506002282294e30), units (molecules/cm^2), scale 1 and offset 0.
// Compare cells in both hemispheres to the same granule before live use.
//
// Dry run: node scripts/seed-no2-activity.mjs --dry-run [--regions=jing-jin-ji,country-de] [--backfill-days=4]
// Daily collection requires EARTHDATA_TOKEN. Dry runs never publish or write series.

import { isMainModule } from './lib/main-module.mjs';
import {
  allSettledWithConcurrency,
  getRedisCredentials,
  loadEnvFile,
  loadSharedConfig,
  markPreservableFetchFailure,
  parseRetryAfterMs,
  redisCommand,
  runSeed,
  withRetry,
  writeExtraKey,
} from './_seed-utils.mjs';
import {
  CHINA_NO2_COMPOSITE,
  NO2_ACTIVITY_ACTIVATION_KEY,
  NO2_ACTIVITY_KEY,
  NO2_ACTIVITY_METHOD,
  NO2_ACTIVITY_MAX_REFRESH_AGE_MS,
  NO2_ACTIVITY_METHOD_VERSION,
  NO2_ACTIVITY_SERIES_KEY_PREFIX,
  NO2_ACTIVITY_SOURCE,
  NO2_ACTIVITY_SOURCE_VERSION,
  NO2_ATTRIBUTION_PREFIX,
  NO2_REGIONS,
  dateMs,
  isHolidayMasked,
  signalFor,
  validateNo2ActivityDataset,
} from './shared/no2-activity.mjs';

const CMR_GRANULES_URL = 'https://cmr.earthdata.nasa.gov/search/granules.json';
const OPENDAP_ORIGIN = 'https://opendap.earthdata.nasa.gov';
const OPENDAP_PATH = '/collections/C3333493715-GES_DISC/granules/';
const USER_AGENT = 'WorldMonitor seed-no2-activity/2.0 (+https://www.worldmonitor.app)';
const REQUEST_TIMEOUT_MS = 25_000;
const REQUEST_ATTEMPTS = 3;
const REQUEST_CONCURRENCY = 3;
const SERIES_TTL_SECONDS = 400 * 24 * 60 * 60;
const DATASET_TTL_SECONDS = 7 * 24 * 60 * 60;
const MGET_CHUNK = 50;
const DAY_MS = 86_400_000;
const GRID_STEP = NO2_ACTIVITY_METHOD.gridResolutionDegrees;
const GRID_WIDTH = 360 / GRID_STEP;
const GRID_HEIGHT = 180 / GRID_STEP;
const GRID_SIZE = GRID_WIDTH * GRID_HEIGHT;
const MOLECULES_CM2_TO_MOL_M2 = 1e4 / 6.02214076e23;

const isoDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (date, days) => isoDate(dateMs(date) + days * DAY_MS);
const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
const seriesKeyFor = (regionId) => `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${regionId}`;

function calendarWindow(dates) {
  return { windowStart: dates[0], windowEnd: dates[dates.length - 1], dates };
}

/** The current window: windowDays UTC dates ending windowEndLagDays before the run date. */
export function currentWindow(nowMs, method = NO2_ACTIVITY_METHOD) {
  const windowEnd = addDays(isoDate(nowMs), -method.windowEndLagDays);
  return calendarWindow(Array.from({ length: method.windowDays }, (_, index) => addDays(windowEnd, index - method.windowDays + 1)));
}

/** The current window's month-day span shifted back `yearsBack` years; Feb 29 drops where the target year has none. */
export function baselineWindow(current, yearsBack) {
  const dates = current.dates
    .map((date) => `${Number(date.slice(0, 4)) - yearsBack}${date.slice(4)}`)
    .filter((date) => Number.isFinite(dateMs(date)));
  return { year: Number(current.windowEnd.slice(0, 4)) - yearsBack, ...calendarWindow(dates) };
}

/** The refresh range [from, to) a run fetches for every region. */
export function refreshRange(current, method = NO2_ACTIVITY_METHOD) {
  return { from: addDays(current.windowEnd, 1 - method.refreshDays), to: addDays(current.windowEnd, 1) };
}

export function emptySeries(region) {
  return { id: region.id, gridResolutionDegrees: GRID_STEP, refreshedAt: null, backfilledYears: [], days: {} };
}

export function parseSeries(value, region) {
  const series = typeof value === 'string' ? safeJson(value) : value;
  if (!series || series.id !== region.id || series.gridResolutionDegrees !== GRID_STEP
    || !series.days || typeof series.days !== 'object' || Array.isArray(series.days)) {
    return emptySeries(region);
  }
  return {
    ...emptySeries(region),
    refreshedAt: typeof series.refreshedAt === 'string' && Number.isFinite(Date.parse(series.refreshedAt)) ? series.refreshedAt : null,
    days: Object.fromEntries(Object.entries(series.days).filter(([date, row]) =>
      Number.isFinite(dateMs(date)) && Array.isArray(row) && row.length === 2
      && (row[0] === null ? row[1] === 0 || row[1] === null
        : Number.isFinite(row[0]) && Number.isFinite(row[1]) && row[1] > 0 && row[1] <= 1))),
  };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function seriesCoverage(series) {
  const dates = Object.keys(series.days).sort();
  return {
    refreshedAt: series.refreshedAt,
    days: dates.length,
    firstDate: dates[0] ?? null,
    lastDate: dates[dates.length - 1] ?? null,
    backfilledYears: [...series.backfilledYears].sort(),
  };
}

/** The calendar years a window touches (a window crossing New Year touches two). */
export function windowYears(window) {
  const first = Number(window.windowStart.slice(0, 4));
  const last = Number(window.windowEnd.slice(0, 4));
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function datesByYear(windows, refreshFrom) {
  const dates = new Map();
  for (const window of windows) {
    for (const year of windowYears(window)) {
      if (!dates.has(year)) dates.set(year, []);
    }
    for (const date of window.dates) {
      if (date < refreshFrom) dates.get(Number(date.slice(0, 4))).push(date);
    }
  }
  return dates;
}

function markBackfilledYears(series, requiredDates) {
  series.backfilledYears = [...requiredDates].filter(([, dates]) =>
    dates.every((date) => Object.hasOwn(series.days, date))).map(([year]) => year).sort();
}

export function summarizeWindow(series, windowStart, windowEnd, holidayCalendar, method = NO2_ACTIVITY_METHOD) {
  const means = [];
  const fractions = [];
  let maskedDays = 0;
  for (let date = windowStart; date <= windowEnd; date = addDays(date, 1)) {
    if (isHolidayMasked(date, holidayCalendar, method)) {
      maskedDays++;
      continue;
    }
    const row = series.days[date];
    if (row && row[0] !== null && row[1] !== null && row[1] >= method.minValidFraction) {
      means.push(row[0]);
      fractions.push(row[1]);
    }
  }
  return {
    windowStart,
    windowEnd,
    validDays: means.length,
    maskedDays,
    meanNo2MolM2: means.length === 0 ? null : mean(means),
    meanValidFraction: fractions.length === 0 ? null : mean(fractions),
  };
}

/**
 * One dataset record from a region's stored series. `refreshFailed` says this
 * run's refresh request failed; the region is still judged on what is stored,
 * and reads request_failed when its last successful refresh is absent or old.
 */
export function regionResult(definition, series, current, baselines, refreshFailed = false, method = NO2_ACTIVITY_METHOD, nowMs = dateMs(current.windowEnd) + method.windowEndLagDays * DAY_MS) {
  const currentWindowSummary = summarizeWindow(series, current.windowStart, current.windowEnd, definition.holidayCalendar, method);
  const years = baselines.map((baseline) => ({
    year: baseline.year,
    ...summarizeWindow(series, baseline.windowStart, baseline.windowEnd, definition.holidayCalendar, method),
  }));
  const backfilled = new Set(series.backfilledYears);
  const covered = (window) => windowYears(window).every((year) => backfilled.has(year));
  const backfilledBaselines = years.filter(covered);
  const eligibleYears = backfilledBaselines.filter((year) => year.validDays >= method.minValidDays);
  const baselineMean = eligibleYears.length >= method.minBaselineYears ? mean(eligibleYears.map((year) => year.meanNo2MolM2)) : null;
  const baseline = { years, meanNo2MolM2: baselineMean !== null && baselineMean > 0 ? baselineMean : null };
  const refreshAgeMs = series.refreshedAt === null ? Infinity : nowMs - Date.parse(series.refreshedAt);
  // Every year a window touches must be backfilled: until then the refresh
  // days alone would read as cloud-starved rather than as not yet fetched.
  const backfillPending = backfilledBaselines.length < method.minBaselineYears || !covered(current);
  const exclusion = refreshFailed && refreshAgeMs > NO2_ACTIVITY_MAX_REFRESH_AGE_MS
    ? 'request_failed'
    : backfillPending
      ? 'baseline_backfill_pending'
      : currentWindowSummary.validDays < method.minValidDays
        ? 'insufficient_valid_days'
        : baseline.meanNo2MolM2 === null
          ? 'insufficient_baseline_years'
          : null;
  const changePercent = exclusion === null
    ? (currentWindowSummary.meanNo2MolM2 / baseline.meanNo2MolM2 - 1) * 100
    : null;
  return {
    id: definition.id,
    kind: definition.kind,
    label: definition.label,
    countryCode: definition.countryCode,
    bbox: [...definition.bbox],
    resolutionDegrees: definition.resolutionDegrees,
    current: currentWindowSummary,
    baseline,
    series: seriesCoverage(series),
    changePercent,
    ...(exclusion === null ? signalFor(changePercent, method) : { signalValue: null, direction: null }),
    exclusion,
  };
}

export function loadGeometries() {
  return loadSharedConfig('no2-region-geometries.generated.json');
}

/** Redis adapter: MGET the stored series in chunks; write one series. */
export function redisSeriesStore() {
  const { url, token } = getRedisCredentials();
  return {
    async readSeries(keys) {
      const values = new Map();
      for (let start = 0; start < keys.length; start += MGET_CHUNK) {
        const chunk = keys.slice(start, start + MGET_CHUNK);
        const { result } = await withRetry(
          () => redisCommand(url, token, ['MGET', ...chunk], { label: 'Redis MGET no2 series' }),
          REQUEST_ATTEMPTS - 1,
          1_000,
        );
        chunk.forEach((key, index) => values.set(key, Array.isArray(result) ? result[index] ?? null : null));
      }
      return values;
    },
    writeSeries(key, series) {
      return writeExtraKey(key, series, SERIES_TTL_SECONDS);
    },
  };
}

function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x, y] = ring[i];
    const [otherX, otherY] = ring[j];
    if ((y > lat) !== (otherY > lat) && lon < x + (otherX - x) * (lat - y) / (otherY - y)) inside = !inside;
  }
  return inside;
}

function ringBounds(ring) {
  const bbox = [180, 90, -180, -90];
  for (const [lon, lat] of ring) {
    bbox[0] = Math.min(bbox[0], lon);
    bbox[1] = Math.min(bbox[1], lat);
    bbox[2] = Math.max(bbox[2], lon);
    bbox[3] = Math.max(bbox[3], lat);
  }
  return bbox;
}

function cellsInBounds(cells, [west, south, east, north], includes = () => true) {
  const firstCol = Math.max(0, Math.ceil((west + 180) / GRID_STEP - 0.5));
  const lastCol = Math.min(GRID_WIDTH - 1, Math.floor((east + 180) / GRID_STEP - 0.5));
  const firstRow = Math.max(0, Math.ceil((south + 90) / GRID_STEP - 0.5));
  const lastRow = Math.min(GRID_HEIGHT - 1, Math.floor((north + 90) / GRID_STEP - 0.5));
  for (let row = firstRow; row <= lastRow; row++) {
    const lat = -90 + (row + 0.5) * GRID_STEP;
    for (let col = firstCol; col <= lastCol; col++) {
      const lon = -180 + (col + 0.5) * GRID_STEP;
      if (includes(lon, lat)) cells.add(row * GRID_WIDTH + col);
    }
  }
}

export function buildRegionMask(region, geometry) {
  const cells = new Set();
  const polygons = region.kind !== 'country' ? null
    : geometry?.type === 'Polygon' ? [geometry.coordinates]
      : geometry?.type === 'MultiPolygon' ? geometry.coordinates : null;
  if (polygons?.length) {
    for (const [outer, ...holes] of polygons) {
      cellsInBounds(cells, ringBounds(outer), (lon, lat) =>
        pointInRing(lon, lat, outer) && !holes.some((hole) => pointInRing(lon, lat, hole)));
    }
  } else {
    cellsInBounds(cells, region.bbox);
  }
  if (cells.size === 0) {
    const [west, south, east, north] = region.bbox;
    const col = Math.min(GRID_WIDTH - 1, Math.floor(((west + east) / 2 + 180) / GRID_STEP));
    const row = Math.min(GRID_HEIGHT - 1, Math.floor(((south + north) / 2 + 90) / GRID_STEP));
    cells.add(row * GRID_WIDTH + col);
  }
  return Uint32Array.from(cells);
}

export function summarizeGrid(grid, mask) {
  let total = 0;
  let valid = 0;
  for (const index of mask) {
    const value = grid[index];
    // The documented fill is about -1.27e30. Also exclude nonfinite and
    // similarly huge sentinels, while retaining finite negative retrievals.
    if (Math.abs(value) < 1e29) {
      total += value;
      valid++;
    }
  }
  return [valid ? (total / valid) * MOLECULES_CM2_TO_MOL_M2 : null, valid / mask.length];
}

function no2DapField(dds) {
  const fields = [...dds.matchAll(/\bFloat32\s+([\w%]+)\s*(\[[^\]]+\]\s*\[[^\]]+\])\s*;/g)]
    .filter(([, name]) => name.endsWith(NO2_ACTIVITY_SOURCE.band));
  if (fields.length !== 1) throw new Error('OMNO2d DDS does not expose a unique Float32 tropospheric NO2 array');
  const [declaration, name, dimensions] = fields[0];
  const sizes = [...dimensions.matchAll(/(?:=|\[)\s*(\d+)\s*\]/g)].map(([, size]) => Number(size));
  const longitudeFirst = sizes[0] === GRID_WIDTH && sizes[1] === GRID_HEIGHT;
  if (!longitudeFirst && (sizes[0] !== GRID_HEIGHT || sizes[1] !== GRID_WIDTH)) {
    throw new Error('OMNO2d DDS grid must have 720 latitudes and 1440 longitudes');
  }
  const enclosingGrid = /\bGrid\s*{\s*ARRAY\s*:\s*$/.test(dds.slice(0, fields[0].index))
    ? dds.slice(fields[0].index + declaration.length).match(/^\s*MAPS\s*:[^}]*}\s*([\w%]+)\s*;/)?.[1]
    : null;
  return { name, projection: enclosingGrid ? `${enclosingGrid}.${name}` : name, longitudeFirst };
}

/** DAP2 .dods: a constrained DDS, Data: delimiter, then an XDR Float32 vector.
 * Numeric DAP2 arrays carry two big-endian counts before their values.
 * Normalize both dimension orders to a south-to-north, longitude-fast grid.
 */
export function decodeNo2Dods(bytes) {
  const data = Buffer.from(bytes);
  const delimiter = /\r?\nData:\r?\n/.exec(data.subarray(0, 4096).toString('ascii'));
  if (!delimiter) throw new Error('OMNO2d DAP2 response has no Data delimiter');
  const { longitudeFirst } = no2DapField(data.subarray(0, delimiter.index).toString('ascii'));
  const start = delimiter.index + delimiter[0].length;
  if (data.length - start !== (GRID_SIZE + 2) * 4
    || data.readUInt32BE(start) !== GRID_SIZE || data.readUInt32BE(start + 4) !== GRID_SIZE) {
    throw new Error('OMNO2d DAP2 response has an unexpected XDR array length');
  }
  const grid = new Float32Array(GRID_SIZE);
  for (let index = 0; index < GRID_SIZE; index++) {
    const target = longitudeFirst ? (index % GRID_HEIGHT) * GRID_WIDTH + Math.floor(index / GRID_HEIGHT) : index;
    grid[target] = data.readFloatBE(start + 8 + index * 4);
  }
  return grid;
}

function opendapGranule(entry, date) {
  const stamp = `${date.slice(0, 4)}m${date.slice(5).replace('-', '')}`;
  const file = new RegExp(`^OMNO2d\\.004(?::|%3A)OMI-Aura_L3-OMNO2d_${stamp}_v004-\\d{4}m\\d{4}t\\d{6}\\.he5$`, 'i');
  for (const link of Array.isArray(entry.links) ? entry.links : []) {
    const url = typeof link?.href === 'string' ? URL.parse(link.href) : null;
    if (url?.origin === OPENDAP_ORIGIN && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.startsWith(OPENDAP_PATH) && file.test(url.pathname.slice(OPENDAP_PATH.length))) return url.href;
  }
  return null;
}

function nasaSource({ fetchImpl, token, usage, retryDelayMs }) {
  async function request(url, label, authenticated = false) {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return withRetry(async () => {
      try {
        signal.throwIfAborted();
        usage.requestCount++;
        const headers = { 'User-Agent': USER_AGENT };
        if (authenticated) headers.Authorization = `Bearer ${token}`;
        const response = await fetchImpl(url, { headers, signal, redirect: 'manual' });
        if (!response.ok) {
          await response.body?.cancel();
          const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
          const error = new Error(`NASA ${label} HTTP ${response.status}`);
          error.nonRetryable = (response.status < 500 && response.status !== 429) || retryAfterMs >= REQUEST_TIMEOUT_MS;
          error.retryAfterMs = retryAfterMs;
          throw error;
        }
        const bytes = await response.arrayBuffer();
        usage.bytesDownloaded += bytes.byteLength;
        return bytes;
      } catch (error) {
        if (signal.aborted) error.nonRetryable = true;
        throw error;
      }
    }, REQUEST_ATTEMPTS - 1, retryDelayMs);
  }

  return {
    async catalog({ windowStart, windowEnd }) {
      const params = new URLSearchParams({
        short_name: 'OMNO2d', version: '004', collection_concept_id: 'C3333493715-GES_DISC',
        temporal: `${windowStart}T00:00:00Z,${windowEnd}T23:59:59Z`,
        page_size: '2000', sort_key: '-revision_date',
      });
      const bytes = await request(`${CMR_GRANULES_URL}?${params}`, 'CMR catalog');
      const entries = JSON.parse(Buffer.from(bytes).toString('utf8'))?.feed?.entry;
      if (!Array.isArray(entries) || entries.length === 2000) throw new Error('Invalid or incomplete OMNO2d CMR catalog');
      const granules = new Map();
      for (const entry of entries) {
        const date = typeof entry?.time_start === 'string' ? entry.time_start.slice(0, 10) : '';
        if (!Number.isFinite(dateMs(date))) throw new Error('Invalid OMNO2d CMR granule date');
        if (date < windowStart || date > windowEnd || granules.get(date)) continue;
        granules.set(date, opendapGranule(entry, date));
      }
      return granules;
    },
    async field(url) {
      const bytes = await request(`${url}.dds`, 'OPeNDAP DDS', true);
      return no2DapField(Buffer.from(bytes).toString('ascii')).projection;
    },
    async grid(url, projection) {
      const bytes = await request(`${url}.dods?${projection}`, 'OPeNDAP DODS', true);
      return decodeNo2Dods(bytes);
    },
  };
}

export function makeFetchAll({
  fetchImpl = (...args) => globalThis.fetch(...args),
  store,
  token,
  now = Date.now,
  method = NO2_ACTIVITY_METHOD,
  regions = NO2_REGIONS,
  geometries = loadGeometries(),
  backfillDays = method.backfillDaysPerRun,
  backfillDeadlineMs = 9 * 60_000,
  concurrency = REQUEST_CONCURRENCY,
  retryDelayMs = 1_000,
  writeSeries = true,
  log = console.log,
}) {
  return async function fetchAll() {
    const runMs = now();
    const startedAt = Date.now();
    const current = currentWindow(runMs, method);
    const baselines = Array.from({ length: method.baselineYears }, (_, index) => baselineWindow(current, index + 1));
    const windows = [current, ...baselines];
    const refresh = refreshRange(current, method);
    const requiredDates = datesByYear(windows, refresh.from);
    const keys = regions.map((region) => seriesKeyFor(region.id));
    const stored = await store.readSeries(keys);
    const series = regions.map((region, index) => parseSeries(stored.get(keys[index]), region));
    const masks = regions.map((region) => buildRegionMask(region, geometries[region.id]));
    const usage = { requestCount: 0, bytesDownloaded: 0 };
    const source = nasaSource({ fetchImpl, token, usage, retryDelayMs });

    let catalog;
    let projection;
    let refreshDates;
    try {
      catalog = await source.catalog(current);
      refreshDates = [...catalog.keys()].filter((date) => date >= refresh.from && catalog.get(date)).sort().reverse();
      if (!refreshDates.length) throw new Error('no OMNO2d granules in the refresh range');
      projection = await source.field(catalog.get(refreshDates[0]));
    } catch (error) {
      throw markPreservableFetchFailure(new Error(`NASA NO2 refresh setup failed: ${error.message}`));
    }

    const fetchDates = async (dates, granules, phase) => {
      const results = await allSettledWithConcurrency(dates, concurrency, async (date) => {
        if (phase === 'backfill' && Date.now() - startedAt > backfillDeadlineMs) throw new Error('deadline reached');
        const grid = await source.grid(granules.get(date), projection);
        series.forEach((item, index) => { item.days[date] = summarizeGrid(grid, masks[index]); });
      });
      results.forEach((result, index) => {
        if (result.status === 'rejected') log(`  NO2 ${phase} ${dates[index]} failed: ${result.reason.message}`);
      });
      return results.some((result) => result.status === 'fulfilled');
    };
    if (!await fetchDates(refreshDates, catalog, 'refresh')) {
      throw markPreservableFetchFailure(new Error(`every NASA NO2 refresh failed (${usage.requestCount} requests); last-good kept`));
    }

    // A successful catalog can confirm that a date has no granule. Store
    // [null, null] to count it as covered, then keep checking for late arrivals.
    // A listed date with no usable link, or a failed request, stays pending.
    const recordCatalogGaps = (window, granules) => {
      for (const date of window.dates) {
        if (date >= refresh.from || granules.has(date)) continue;
        for (const item of series) item.days[date] ??= [null, null];
      }
    };
    const missing = (date) => series.some((item) => !item.days[date] || item.days[date][1] === null);
    if (backfillDays > 0) {
      recordCatalogGaps(current, catalog);
      const historical = baselines.filter((window) => window.dates.some(missing));
      const catalogs = await allSettledWithConcurrency(historical, concurrency, (window) => source.catalog(window));
      catalogs.forEach((result, index) => {
        if (result.status === 'fulfilled') {
          recordCatalogGaps(historical[index], result.value);
          for (const [date, url] of result.value) catalog.set(date, url);
        } else {
          log(`  NO2 catalog ${historical[index].year} failed: ${result.reason.message}`);
        }
      });
      const queue = windows.flatMap((window) => [...window.dates].reverse())
        .filter((date) => date < refresh.from && catalog.get(date) && missing(date)).slice(0, backfillDays);
      await fetchDates(queue, catalog, 'backfill');
    }

    const generatedAt = new Date(runMs).toISOString();
    const keepFrom = baselines.at(-1)?.windowStart ?? current.windowStart;
    for (const [index, item] of series.entries()) {
      item.refreshedAt = generatedAt;
      for (const date of Object.keys(item.days)) {
        if (date < keepFrom || date > current.windowEnd) delete item.days[date];
      }
      markBackfilledYears(item, requiredDates);
      if (writeSeries) await store.writeSeries(keys[index], item);
    }
    const records = regions.map((region, index) => regionResult(region, series[index], current, baselines, false, method, runMs));
    const firstDates = records.map((record) => record.series.firstDate).filter(Boolean).sort();
    log(`  NO2 requests=${usage.requestCount} bytes=${usage.bytesDownloaded}`);
    return {
      methodVersion: NO2_ACTIVITY_METHOD_VERSION,
      generatedAt,
      method: JSON.parse(JSON.stringify(method)),
      source: {
        ...NO2_ACTIVITY_SOURCE,
        attribution: `${NO2_ATTRIBUTION_PREFIX} ${firstDates[0].slice(0, 4)}-${current.windowEnd.slice(0, 4)}`,
        ...usage,
      },
      regions: Object.fromEntries(records.map((record) => [record.id, record])),
    };
  };
}

/** A record for a region this run did not touch, so a partial run still assembles a full dataset. */
export function pendingRecord(definition, nowMs, method = NO2_ACTIVITY_METHOD) {
  const current = currentWindow(nowMs, method);
  const baselines = Array.from({ length: method.baselineYears }, (_, index) => baselineWindow(current, index + 1));
  return regionResult(definition, emptySeries(definition), current, baselines, false, method);
}

export function declareRecords(data) {
  return Object.values(data?.regions ?? {}).filter((region) => region?.exclusion === null).length;
}

export async function publishNo2Atomically(_data, { canonicalKey, payload, ttlSeconds }, { url, token } = getRedisCredentials()) {
  const { result } = await redisCommand(url, token, [
    'EVAL',
    "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2]); redis.call('SET', KEYS[2], '1'); return 1",
    2, canonicalKey, NO2_ACTIVITY_ACTIVATION_KEY, payload, ttlSeconds,
  ], { label: 'NO2 dataset and activation publication' });
  if (result !== 1) throw new Error('NO2 dataset and activation publication was not confirmed');
}

function argValue(name) {
  const prefix = `--${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

const formatNumber = (value, digits = 3) => (value === null ? 'null' : Number(value).toPrecision(digits));
const formatWindow = (window) => `${window.windowStart}..${window.windowEnd} valid=${window.validDays} masked=${window.maskedDays} mean=${formatNumber(window.meanNo2MolM2)} frac=${formatNumber(window.meanValidFraction, 2)}`;

async function main() {
  loadEnvFile(import.meta.url);
  const dryRun = process.argv.includes('--dry-run');
  const token = process.env.EARTHDATA_TOKEN?.trim();
  if (!token) {
    console.log('NO SOURCE: EARTHDATA_TOKEN unset; skipped NO2 activity collection');
    return;
  }
  const backfillArg = argValue('backfill-days');
  const backfillDays = backfillArg === undefined ? undefined : Number(backfillArg);
  if (backfillArg !== undefined && (!/^\d+$/.test(backfillArg) || !Number.isSafeInteger(backfillDays))) {
    throw new Error('--backfill-days requires a non-negative integer');
  }

  if (dryRun) {
    const ids = argValue('regions')?.split(',').map((id) => id.trim()).filter(Boolean)
      ?? [...CHINA_NO2_COMPOSITE.regionIds, 'country-de', 'country-ru', 'country-us', 'country-br', 'country-in'];
    const regions = NO2_REGIONS.filter((region) => ids.includes(region.id));
    if (!regions.length) throw new Error('--regions must include a registered NO2 region');
    const hasRedis = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
    const store = hasRedis ? redisSeriesStore() : { readSeries: async () => new Map() };
    console.log(`no2 activity dry run: ${regions.length} of ${NO2_REGIONS.length} regions, backfill grid days ${backfillDays ?? 0}, stored series ${hasRedis ? 'read' : 'unavailable'}, nothing written`);
    const nowMs = Date.now();
    const fetchAll = makeFetchAll({ store, token, regions, now: () => nowMs, backfillDays: backfillDays ?? 0, writeSeries: false });
    try {
      const partial = await fetchAll();
      for (const record of Object.values(partial.regions)) {
        console.log(`  ${record.id}: exclusion=${record.exclusion} change=${formatNumber(record.changePercent, 4)}% direction=${record.direction} series=${record.series.days}d backfilled=[${record.series.backfilledYears.join(',')}]`);
        console.log(`    current  ${formatWindow(record.current)}`);
        for (const year of record.baseline.years) console.log(`    ${year.year}     ${formatWindow(year)}`);
      }
      const full = {
        ...partial,
        regions: Object.fromEntries(NO2_REGIONS.map((definition) => [definition.id, partial.regions[definition.id] ?? pendingRecord(definition, nowMs)])),
      };
      console.log(`  requests=${partial.source.requestCount} bytes=${partial.source.bytesDownloaded} attribution="${partial.source.attribution}"`);
      console.log(`  valid full dataset: ${validateNo2ActivityDataset(full)}; eligible records: ${declareRecords(full)}`);
    } catch (error) {
      console.log(`  NO2 dry run failed: ${error.message}`);
      process.exitCode = 75;
    }
    return;
  }

  const fetchAll = makeFetchAll({ store: redisSeriesStore(), token, backfillDays });
  console.log(`no2 activity: ${NO2_REGIONS.length} regions, backfill grid days ${backfillDays ?? NO2_ACTIVITY_METHOD.backfillDaysPerRun}`);
  await runSeed('economic', 'no2-activity', NO2_ACTIVITY_KEY, fetchAll, {
    validateFn: validateNo2ActivityDataset,
    publishAtomically: publishNo2Atomically,
    ttlSeconds: DATASET_TTL_SECONDS,
    declareRecords,
    zeroIsValid: true,
    schemaVersion: 2,
    sourceVersion: NO2_ACTIVITY_SOURCE_VERSION,
    maxStaleMin: 4320, // 3 x the 20 6 * * * cron
    fetchPhaseTimeoutMs: 12 * 60_000,
    lockTtlMs: 18 * 60_000,
  });
}

if (isMainModule(import.meta.url, process.argv[1])) {
  main().catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
