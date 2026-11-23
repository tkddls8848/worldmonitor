import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  baselineWindow,
  buildRegionMask,
  decodeNo2Dods,
  currentWindow,
  declareRecords,
  emptySeries,
  loadGeometries,
  makeFetchAll,
  parseSeries,
  pendingRecord,
  publishNo2Atomically,
  refreshRange,
  regionResult,
  summarizeGrid,
  summarizeWindow,
  windowYears,
} from '../scripts/seed-no2-activity.mjs';
import {
  NO2_ACTIVITY_METHOD,
  NO2_ACTIVITY_SOURCE,
  NO2_ACTIVITY_ACTIVATION_KEY,
  NO2_ACTIVITY_MAX_REFRESH_AGE_MS,
  NO2_ACTIVITY_SERIES_KEY_PREFIX,
  NO2_REGIONS,
  validateNo2ActivityDataset,
} from '../scripts/shared/no2-activity.mjs';

const DAY_MS = 86_400_000;
const NOW = Date.parse('2026-10-26T06:20:00Z');
const region = (id) => NO2_REGIONS.find((item) => item.id === id);
const JJJ = region('jing-jin-ji');
const DE = region('country-de');

function seriesWith(regionDef, days, backfilledYears = []) {
  return { ...emptySeries(regionDef), refreshedAt: new Date(NOW).toISOString(), backfilledYears, days };
}

function denseDays(from, count, meanValue, fraction = 0.6) {
  const days = {};
  const fromMs = Date.parse(`${from}T00:00:00Z`);
  for (let index = 0; index < count; index++) {
    days[new Date(fromMs + index * DAY_MS).toISOString().slice(0, 10)] = [meanValue, fraction];
  }
  return days;
}

describe('seed-no2-activity calendar', () => {
  it('ends the current window windowEndLagDays before the UTC run date and refreshes the trailing days', () => {
    const current = currentWindow(NOW);
    assert.equal(current.windowEnd, '2026-10-23');
    assert.equal(current.windowStart, '2026-08-29');
    assert.equal(current.dates.length, 56);
    assert.deepEqual(refreshRange(current), { from: '2026-10-14', to: '2026-10-24' });
  });

  it('maps the same month-day span to each baseline year and drops Feb 29', () => {
    const current = currentWindow(NOW);
    const prior = baselineWindow(current, 1);
    assert.deepEqual([prior.year, prior.windowStart, prior.windowEnd, prior.dates.length], [2025, '2025-08-29', '2025-10-23', 56]);
    const leap = baselineWindow(currentWindow(Date.parse('2028-03-10T00:00:00Z')), 1);
    assert.equal(leap.dates.includes('2027-02-29'), false);
    assert.equal(leap.dates.length, 55);
  });

  it('keeps both calendar years in a window crossing New Year', () => {
    const january = currentWindow(Date.parse('2027-01-20T06:00:00Z'));
    assert.deepEqual([january.windowStart, january.windowEnd], ['2026-11-23', '2027-01-17']);
    assert.deepEqual(windowYears(january), [2026, 2027]);
  });
});

describe('NO2 stored series', () => {
  it('validates cached rows and recomputes completed years', () => {
    const original = seriesWith(JJJ, {
      '2026-10-01': [1e-4, 0.6],
      '2026-10-02': [null, 0],
      '2026-10-03': [1e-4, '0.6'],
      '2026-10-04': [1e-4, 1.2],
      '2026-02-30': [1e-4, 1],
    }, [2025, 2026]);
    assert.deepEqual(parseSeries(JSON.stringify(original), JJJ), {
      ...original, backfilledYears: [], days: { '2026-10-01': [1e-4, 0.6], '2026-10-02': [null, 0] },
    });
    assert.deepEqual(parseSeries({ ...original, gridResolutionDegrees: 0.5 }, JJJ), emptySeries(JJJ));
    assert.deepEqual(parseSeries('not json', JJJ), emptySeries(JJJ));
    assert.deepEqual(parseSeries(null, JJJ), emptySeries(JJJ));
  });
});

describe('seed-no2-activity window summary and region result', () => {
  const current = currentWindow(NOW);
  const baselines = [1, 2, 3].map((years) => baselineWindow(current, years));

  it('gates days at the minimum valid fraction and masks holidays only on the region calendar', () => {
    const series = seriesWith(JJJ, { '2026-02-10': [1e-4, 0.5], '2026-02-11': [2e-4, 0.19], '2026-02-12': [3e-4, 0.2], '2026-03-04': [4e-4, 0.9] });
    const masked = summarizeWindow(series, '2026-02-10', '2026-03-04', 'lunar_new_year');
    assert.equal(masked.maskedDays, 22);
    assert.equal(masked.validDays, 1);
    assert.equal(masked.meanNo2MolM2, 4e-4);
    const unmasked = summarizeWindow(series, '2026-02-10', '2026-03-04', null);
    assert.equal(unmasked.maskedDays, 0);
    assert.equal(unmasked.validDays, 3);
    assert.ok(Math.abs(unmasked.meanNo2MolM2 - (1e-4 + 3e-4 + 4e-4) / 3) < 1e-18);
    assert.deepEqual(summarizeWindow(emptySeries(DE), '2026-02-10', '2026-02-12', null), {
      windowStart: '2026-02-10', windowEnd: '2026-02-12', validDays: 0, maskedDays: 0, meanNo2MolM2: null, meanValidFraction: null,
    });
  });

  it('computes the change against the mean of the eligible backfilled baseline years', () => {
    const days = {
      ...denseDays('2026-08-29', 56, 1.2e-4),
      ...denseDays('2025-08-29', 56, 1.0e-4),
      ...denseDays('2024-08-29', 56, 1.1e-4),
      ...denseDays('2023-08-29', 10, 5e-4),
    };
    const result = regionResult(DE, seriesWith(DE, days, [2023, 2024, 2025, 2026]), current, baselines);
    assert.equal(result.exclusion, null);
    assert.ok(Math.abs(result.baseline.meanNo2MolM2 - 1.05e-4) < 1e-18);
    assert.ok(Math.abs(result.changePercent - (1.2e-4 / 1.05e-4 - 1) * 100) < 1e-9);
    assert.equal(result.direction, 'strengthening');
    assert.equal(result.signalValue, result.changePercent);
    assert.deepEqual(result.baseline.years.map((year) => [year.year, year.validDays]), [[2025, 56], [2024, 56], [2023, 10]]);
    assert.deepEqual(result.series, { refreshedAt: new Date(NOW).toISOString(), days: 178, firstDate: '2023-08-29', lastDate: '2026-10-23', backfilledYears: [2023, 2024, 2025, 2026] });
    assert.equal(validateNo2ActivityDataset({ ...datasetAround([result]) }), true);
  });

  it('names every exclusion and keeps a stored series alive through one failed refresh', () => {
    const full = { ...denseDays('2026-08-29', 56, 1.2e-4), ...denseDays('2025-08-29', 56, 1e-4), ...denseDays('2024-08-29', 56, 1e-4) };
    assert.equal(regionResult(DE, seriesWith(DE, full, [2026]), current, baselines).exclusion, 'baseline_backfill_pending');
    assert.equal(regionResult(DE, seriesWith(DE, { ...full, ...denseDays('2026-08-29', 56, 1.2e-4, 0.1) }, [2024, 2025, 2026]), current, baselines).exclusion, 'insufficient_valid_days');
    assert.equal(regionResult(DE, seriesWith(DE, { ...denseDays('2026-08-29', 56, 1.2e-4), ...denseDays('2025-08-29', 5, 1e-4), ...denseDays('2024-08-29', 56, 1e-4) }, [2024, 2025, 2026]), current, baselines).exclusion, 'insufficient_baseline_years');
    const survived = regionResult(DE, seriesWith(DE, full, [2024, 2025, 2026]), current, baselines, true);
    assert.equal(survived.exclusion, null);
    const failed = regionResult(DE, emptySeries(DE), current, baselines, true);
    assert.equal(failed.exclusion, 'request_failed');
    const january = currentWindow(Date.parse('2027-01-20T06:00:00Z'));
    const januaryBaselines = [1, 2, 3].map((years) => baselineWindow(january, years));
    const crossing = { ...denseDays('2026-11-23', 56, 1.2e-4), ...denseDays('2025-11-23', 56, 1e-4), ...denseDays('2024-11-23', 56, 1e-4) };
    assert.equal(regionResult(DE, seriesWith(DE, crossing, [2024, 2025, 2026, 2027]), january, januaryBaselines).exclusion, null);
    assert.equal(regionResult(DE, seriesWith(DE, crossing, [2025, 2026, 2027]), january, januaryBaselines).exclusion, 'baseline_backfill_pending', 'the 2024-11 baseline window touches an unbackfilled year');
    assert.equal(failed.changePercent, null);
    assert.equal(failed.direction, null);
    assert.equal(pendingRecord(DE, NOW).exclusion, 'baseline_backfill_pending');
  });

  it('excludes retained data after its fixed refresh deadline', () => {
    const series = seriesWith(DE, {
      ...denseDays('2026-08-29', 56, 1.2e-4),
      ...denseDays('2025-08-29', 56, 1e-4),
      ...denseDays('2024-08-29', 56, 1e-4),
    }, [2024, 2025, 2026]);
    series.refreshedAt = new Date(NOW - NO2_ACTIVITY_MAX_REFRESH_AGE_MS).toISOString();
    assert.equal(regionResult(DE, series, current, baselines, true, NO2_ACTIVITY_METHOD, NOW).exclusion, null);
    assert.equal(regionResult(DE, series, current, baselines, true, NO2_ACTIVITY_METHOD, NOW + 1).exclusion, 'request_failed');
    series.refreshedAt = null;
    assert.equal(regionResult(DE, series, current, baselines, true, NO2_ACTIVITY_METHOD, NOW).exclusion, 'request_failed');
  });
});

describe('NO2 atomic publication', () => {
  it('sends the payload and durable activation marker in one Redis command', async (t) => {
    const commands = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
      commands.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ result: 1 }));
    });
    await publishNo2Atomically({}, { canonicalKey: 'economic:no2-activity:v1', payload: '{}', ttlSeconds: 604800 }, { url: 'https://redis.test', token: 'test' });
    assert.equal(commands.length, 1);
    assert.equal(commands[0][0], 'EVAL');
    assert.match(commands[0][1], /SET.*KEYS\[1\].*EX.*SET.*KEYS\[2\]/);
    assert.deepEqual(commands[0].slice(2), [2, 'economic:no2-activity:v1', NO2_ACTIVITY_ACTIVATION_KEY, '{}', 604800]);
  });

  it('fails publication when Redis rejects or does not confirm the atomic write', async (t) => {
    for (const response of [{ error: 'publication failed' }, { result: null }]) {
      t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(response)));
      await assert.rejects(publishNo2Atomically({}, { canonicalKey: 'economic:no2-activity:v1', payload: '{}', ttlSeconds: 604800 }, { url: 'https://redis.test', token: 'test' }), /publication/);
    }
  });
});

function datasetAround(records) {
  return {
    methodVersion: 'no2-activity/v2',
    generatedAt: new Date(NOW).toISOString(),
    method: JSON.parse(JSON.stringify(NO2_ACTIVITY_METHOD)),
    source: { ...NO2_ACTIVITY_SOURCE, attribution: 'NASA OMI/Aura OMNO2d (GES DISC) 2023-2026', requestCount: 1, bytesDownloaded: 4_147_208 },
    regions: Object.fromEntries(NO2_REGIONS.map((definition) => [
      definition.id,
      records.find((record) => record.id === definition.id) ?? pendingRecord(definition, NOW),
    ])),
  };
}

const WIDTH = 1440;
const HEIGHT = 720;
const CELLS = WIDTH * HEIGHT;
const FIELD = 'HDFEOS_GRIDS_ColumnAmountNO2_Data_Fields_ColumnAmountNO2TropCloudScreened';
const dds = (dimensions = '[YDim = 720][XDim = 1440]') => `Dataset { Float32 ${FIELD}${dimensions}; } omno2d;`;
const cell = (col, row) => row * WIDTH + col;

// DAP2 encodes Float32 arrays as two XDR element counts followed by values.
function dodsFixture({ longitudeFirst = false, values = [[0, 2e15]], dimensions, newline = '\n' } = {}) {
  const header = Buffer.from(`${dds(dimensions ?? (longitudeFirst ? '[XDim = 1440][YDim = 720]' : undefined))}${newline}Data:${newline}`);
  const payload = Buffer.alloc(8 + CELLS * 4);
  payload.writeUInt32BE(CELLS, 0);
  payload.writeUInt32BE(CELLS, 4);
  for (const [index, value] of values) {
    const sourceIndex = longitudeFirst ? (index % WIDTH) * HEIGHT + Math.floor(index / WIDTH) : index;
    payload.writeFloatBE(value, 8 + sourceIndex * 4);
  }
  return Buffer.concat([header, payload]);
}

describe('OMNO2d DAP2 decoder and regional masks', () => {
  it('decodes bounded XDR Float32 values and normalizes either dimension order', () => {
    const values = [[cell(100, 20), 2e15], [cell(200, 500), -1e14], [CELLS - 1, -1.2676506002282294e30]];
    for (const longitudeFirst of [false, true]) {
      const grid = decodeNo2Dods(dodsFixture({ values, longitudeFirst, newline: '\r\n' }));
      assert.ok(grid instanceof Float32Array);
      assert.equal(grid.length, CELLS);
      for (const [index, value] of values) assert.equal(grid[index], Math.fround(value));
      assert.equal(grid[1], 0);
    }
  });

  it('rejects HTML, wrong dimensions, malformed counts and truncated data', () => {
    assert.throws(() => decodeNo2Dods(Buffer.from('<html>Earthdata Login</html>')), /Data delimiter/);
    assert.throws(() => decodeNo2Dods(dodsFixture({ dimensions: '[XDim = 720][YDim = 720]' })), /720 latitudes and 1440 longitudes/);
    const fixture = dodsFixture();
    assert.throws(() => decodeNo2Dods(fixture.subarray(0, -4)), /array length/);
    fixture.writeUInt32BE(2, fixture.indexOf('Data:\n') + 10);
    assert.throws(() => decodeNo2Dods(fixture), /array length/);
  });

  it('selects polygon centres, excludes holes, unions disjoint parts and uses cluster bounds', () => {
    const square = (x, y, side) => [[x, y], [x + side, y], [x + side, y + side], [x, y + side], [x, y]];
    const geometry = { type: 'MultiPolygon', coordinates: [
      [square(-180, -90, 0.5), square(-179.75, -89.75, 0.25)],
      [square(179.75, 89.75, 0.25)],
    ] };
    const bbox = [-180, -90, -179.5, -89.5];
    assert.deepEqual([...buildRegionMask({ ...DE, bbox }, geometry)], [0, 1, WIDTH, CELLS - 1]);
    assert.deepEqual([...buildRegionMask({ ...JJJ, bbox }, geometry)], [0, 1, WIDTH, WIDTH + 1]);
    assert.deepEqual([...buildRegionMask({ ...DE, bbox })], [0, 1, WIDTH, WIDTH + 1]);
  });

  it('falls back to the cell containing a tiny region’s centre and converts valid values to mol/m²', () => {
    const bbox = [-179.98, -89.98, -179.96, -89.96];
    const geometry = { type: 'Polygon', coordinates: [[[-179.98, -89.98], [-179.96, -89.98], [-179.96, -89.96], [-179.98, -89.98]]] };
    assert.deepEqual([...buildRegionMask({ ...DE, bbox }, geometry)], [0]);
    const grid = Float32Array.of(3e15, -1e15, -1.2676506002282294e30, NaN, Infinity, 1e30);
    const [mean, coverage] = summarizeGrid(grid, Uint32Array.of(0, 1, 2, 3, 4, 5));
    assert.ok(Math.abs(mean - 1e15 * 1e4 / 6.02214076e23) < 1e-12);
    assert.equal(coverage, 1 / 3);
    assert.deepEqual(summarizeGrid(grid, Uint32Array.of(2, 3, 4, 5)), [null, 0]);
  });
});

const GRANULE_ROOT = 'https://opendap.earthdata.nasa.gov/collections/C3333493715-GES_DISC/granules/';
function granule(date, root = GRANULE_ROOT) {
  return {
    time_start: `${date}T00:00:00.000Z`,
    links: [{ href: `${root}OMNO2d.004%3AOMI-Aura_L3-OMNO2d_${date.slice(0, 4)}m${date.slice(5).replace('-', '')}_v004-2026m1026t062000.he5` }],
  };
}

function stubNasa({ fail = () => false, unlisted = [], extraEntries = [], ddsStatus = 200 } = {}) {
  const calls = { catalogs: [], dds: [], grids: [], bytes: 0 };
  const validGrid = dodsFixture({ values: [[0, 2e15], [1, 4e15]] });
  const from = (body, status = 200) => {
    if (status === 200) calls.bytes += Buffer.byteLength(body);
    return new Response(body, { status });
  };
  const fetchImpl = async (url, init) => {
    assert.match(init.headers['User-Agent'], /^WorldMonitor seed-no2-activity/);
    assert.equal(init.redirect, 'manual');
    const { origin, pathname, searchParams } = new URL(url);
    if (origin === 'https://cmr.earthdata.nasa.gov') {
      assert.equal(init.headers.Authorization, undefined);
      assert.equal(searchParams.get('short_name'), 'OMNO2d');
      assert.equal(searchParams.get('version'), '004');
      const [start, end] = searchParams.get('temporal').split(',').map((time) => time.slice(0, 10));
      calls.catalogs.push([start, end]);
      const entries = Object.keys(denseDays(start, (Date.parse(end) - Date.parse(start)) / DAY_MS + 1, 1))
        .filter((date) => !unlisted.includes(date)).map((date) => granule(date));
      return from(JSON.stringify({ feed: { entry: [...extraEntries, ...entries] } }));
    }
    assert.equal(origin, 'https://opendap.earthdata.nasa.gov');
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    const [, year, month, day] = /_(\d{4})m(\d{2})(\d{2})_v004-/.exec(pathname);
    const date = `${year}-${month}-${day}`;
    if (pathname.endsWith('.dds')) {
      calls.dds.push(date);
      return from(dds(), ddsStatus);
    }
    assert.ok(pathname.endsWith('.dods'));
    assert.equal([...searchParams.keys()][0], FIELD);
    calls.grids.push(date);
    return fail(date) ? from('unavailable', 503) : from(validGrid);
  };
  return { fetchImpl, calls };
}

function stubStore() {
  const state = new Map();
  const writes = [];
  const store = {
    async readSeries(keys) {
      return new Map(keys.map((key) => [key, state.get(key)]));
    },
    async writeSeries(key, value) {
      writes.push(key);
      state.set(key, JSON.stringify(value));
    },
  };
  return { store, state, writes };
}

const SMALL_REGIONS = [
  { ...JJJ, bbox: [-180, -90, -179.75, -89.75] },
  { ...DE, bbox: [-179.75, -90, -179.5, -89.75] },
];
const SHORT_METHOD = { ...NO2_ACTIVITY_METHOD, windowDays: 4, refreshDays: 2, minValidDays: 1 };
function fixtureFetch(store, fetchImpl, overrides) {
  return makeFetchAll({
    store, fetchImpl, token: 'test-token', regions: SMALL_REGIONS, geometries: {},
    method: SHORT_METHOD, now: () => NOW, retryDelayMs: 0, log: () => {}, ...overrides,
  });
}

describe('NASA NO2 date-based collection', () => {
  it('downloads one subset per available date for every region and resumes a bounded backfill', async () => {
    const { store, writes } = stubStore();
    const { fetchImpl, calls } = stubNasa({
      unlisted: ['2026-10-23'],
      extraEntries: [granule('2026-10-23', 'https://untrusted.test/granules/')],
    });
    const fetchAll = fixtureFetch(store, fetchImpl, { backfillDays: 3 });
    const partial = await fetchAll();
    assert.deepEqual(calls.dds, ['2026-10-22']);
    assert.deepEqual(calls.grids, ['2026-10-22', '2026-10-21', '2026-10-20', '2025-10-23']);
    assert.deepEqual(writes, SMALL_REGIONS.map((item) => `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${item.id}`));
    assert.equal(partial.source.requestCount, calls.catalogs.length + calls.dds.length + calls.grids.length);
    assert.equal(partial.source.bytesDownloaded, calls.bytes);
    assert.equal(partial.regions[JJJ.id].current.validDays, 3);
    assert.equal(partial.regions[DE.id].current.meanNo2MolM2, partial.regions[JJJ.id].current.meanNo2MolM2 * 2);
    assert.deepEqual(partial.regions[DE.id].series.backfilledYears, [2026]);
    assert.equal(partial.regions[DE.id].exclusion, 'baseline_backfill_pending');

    calls.grids.length = 0;
    const next = await fetchAll();
    assert.deepEqual(calls.grids, ['2026-10-22', '2025-10-22', '2025-10-21', '2025-10-20']);
    assert.deepEqual(next.regions[DE.id].series.backfilledYears, [2025, 2026]);
  });

  it('derives coverage for both years of a window and records a zero-validity day as fetched', async () => {
    const { store, state } = stubStore();
    const { fetchImpl, calls } = stubNasa();
    const now = () => Date.parse('2027-01-05T03:00:00Z');
    const [cluster, country] = SMALL_REGIONS;
    const keys = SMALL_REGIONS.map((item) => `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${item.id}`);
    for (const [index, key] of keys.entries()) {
      const item = SMALL_REGIONS[index];
      const days = { '2026-01-01': [1e-4, 1], '2026-01-02': [1e-4, 1], '2026-12-30': [null, 0] };
      if (item === cluster) days['2026-12-31'] = [1e-4, 1];
      await store.writeSeries(key, seriesWith(item, days, [2025]));
    }
    const data = await fixtureFetch(store, fetchImpl, { now, backfillDays: 1 })();
    assert.deepEqual(calls.grids, ['2027-01-02', '2027-01-01', '2026-12-31']);
    assert.deepEqual(data.regions[country.id].series.backfilledYears, [2026, 2027]);
    assert.deepEqual(JSON.parse(state.get(keys[1])).days['2026-12-30'], [null, 0]);
  });

  it('keeps a cached day through a partial refresh failure and retries that date', async () => {
    const { store, state } = stubStore();
    const key = `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${JJJ.id}`;
    await store.writeSeries(key, seriesWith(JJJ, { '2026-10-23': [1e-4, 1] }));
    const { fetchImpl, calls } = stubNasa({ fail: (date) => date === '2026-10-23' });
    const data = await fixtureFetch(store, fetchImpl, { backfillDays: 0 })();
    assert.equal(calls.grids.filter((date) => date === '2026-10-23').length, 3);
    assert.deepEqual(calls.catalogs, [['2026-10-20', '2026-10-23']]);
    assert.deepEqual(JSON.parse(state.get(key)).days['2026-10-23'], [1e-4, 1]);
    assert.equal(data.regions[JJJ.id].series.refreshedAt, new Date(NOW).toISOString());
  });

  it('covers catalog-confirmed gaps as invalid days and replaces them when a granule arrives', async () => {
    const { store, state } = stubStore();
    const key = `${NO2_ACTIVITY_SERIES_KEY_PREFIX}${JJJ.id}`;
    const absent = stubNasa({ unlisted: ['2026-10-21', '2025-10-21'] });
    const first = await fixtureFetch(store, absent.fetchImpl, { backfillDays: 5 })();
    assert.ok(!absent.calls.grids.includes('2026-10-21'));
    assert.deepEqual(first.regions[JJJ.id].series.backfilledYears, [2025, 2026]);
    assert.deepEqual(JSON.parse(state.get(key)).days['2025-10-21'], [null, null]);
    assert.equal(first.regions[JJJ.id].baseline.years[0].validDays, 3);

    const repaired = stubNasa();
    const second = await fixtureFetch(store, repaired.fetchImpl, { backfillDays: 2 })();
    assert.deepEqual(repaired.calls.grids, ['2026-10-23', '2026-10-22', '2026-10-21', '2025-10-21']);
    assert.deepEqual(second.regions[JJJ.id].series.backfilledYears, [2025, 2026]);
    assert.equal(second.regions[JJJ.id].baseline.years[0].validDays, 4);
  });

  it('preserves last-good on failed authentication or a fully failed refresh', async () => {
    const { store, writes } = stubStore();
    const redirected = stubNasa({ ddsStatus: 302 });
    await assert.rejects(fixtureFetch(store, redirected.fetchImpl)(), /OPeNDAP DDS HTTP 302/);
    assert.equal(redirected.calls.dds.length, 1);
    const broken = stubNasa({ fail: () => true });
    await assert.rejects(fixtureFetch(store, broken.fetchImpl)(), /every NASA NO2 refresh failed/);
    assert.equal(writes.length, 0);
  });

  it('supports a dry run with no series writes', async () => {
    const { store, writes } = stubStore();
    const { fetchImpl } = stubNasa();
    const data = await fixtureFetch(store, fetchImpl, { backfillDays: 0, writeSeries: false })();
    assert.equal(data.regions[JJJ.id].current.validDays, 2);
    assert.equal(writes.length, 0);
    assert.equal(declareRecords(data), 0);
  });

  it('assembles a validated publication for all 199 registered masks', async () => {
    const { store } = stubStore();
    const { fetchImpl, calls } = stubNasa();
    const fetchAll = fixtureFetch(store, fetchImpl, {
      method: NO2_ACTIVITY_METHOD, regions: NO2_REGIONS, geometries: loadGeometries(), backfillDays: 0,
    });
    const data = await fetchAll();
    assert.equal(calls.grids.length, 10);
    assert.equal(Object.keys(data.regions).length, 199);
    assert.equal(data.regions['country-lu'].current.validDays, 10);
    assert.equal(validateNo2ActivityDataset(data), true);
  });
});
