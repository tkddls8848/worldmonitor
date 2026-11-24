import assert from 'node:assert/strict';
import test from 'node:test';
import { __testing__ as health } from '../api/health.js';
import { bootstrapTierKeyNames, BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';
import { DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN } from '../scripts/personal-collect.mjs';
import { globalIndicatorEvents, globalIndicatorGauges, loadGlobalIndicators, readGlobalIndicators } from '../src/services/global-indicators';

const seeds = [
  ['oecdCli', 'oecd-cli', 1440],
  ['gpr', 'gpr', 360],
  ['imfCofer', 'imf-cofer', 1440],
  ['pinkSheet', 'pink-sheet', 1440],
] as const;
const gprDay = { date: '2026-11-23', value: 500, average30d: 300, normal: 180, dailySpike: true, sustainedSpike: true };
const payloads = {
  oecdCli: { series: {
    G20: { period: '2026-10', value: 99.96, phase: 'downturn', change: -0.05, turningPoint: null },
    US: { period: '2026-10', value: 100.9, phase: 'expansion', change: 0.05, turningPoint: 'trough' },
    CN: { period: '2026-10', value: 100, phase: 'invalid', change: 0, turningPoint: 'trough' },
  } },
  gpr: { latest: gprDay, countries: { US: { period: '2026-10', value: 3.76 }, RU: { period: 'invalid', value: 7 } },
    spikes: [gprDay, { ...gprDay, date: 'invalid' }] },
  imfCofer: { latest: { period: '2026-Q2', shares: { USD: 56.7 }, usdYoyPp: -0.24 } },
  pinkSheet: { latest: { period: '2026-10', indices: { energy: { yoyPct: 89.3 }, food: { yoyPct: 14.7 } } },
    spikes: [{ period: '2026-10', key: 'energy', momPct: -12 }, { period: '2026-10', key: 'food', momPct: 10 }] },
};

test('each independent source has a personal collector, health key and on-demand reader', async (t) => {
  for (const [key, name, interval] of seeds) {
    assert.ok(DEFAULT_COLLECTORS.includes(name));
    assert.equal(STANDALONE_INTERVAL_MIN[name], interval);
    assert.ok(bootstrapTierKeyNames('on-demand').includes(key));
    assert.equal(health.STANDALONE_KEYS[key], BOOTSTRAP_CACHE_KEYS[key]);
    assert.equal(health.SEED_META[key].key, `seed-meta:economic:${name}`);
    assert.equal(health.SEED_META[key].maxStaleMin, interval * 3);
    assert.equal(health.ACTIVATION_MARKERS[key], `seed-activated:economic:${name}`);
    assert.ok(health.ON_DEMAND_KEYS.has(key));
  }
  const fetchMock = t.mock.method(globalThis, 'fetch', async (input: RequestInfo | URL) => {
    const key = new URL(String(input), 'http://local.test').searchParams.get('keys')!;
    assert.ok(Object.hasOwn(payloads, key));
    if (key === 'imfCofer') return new Response(null, { status: 503 });
    return Response.json({ data: { [key]: payloads[key as keyof typeof payloads] } });
  });
  const data = await loadGlobalIndicators();
  assert.equal(fetchMock.mock.calls.length, 4);
  assert.equal(data.cofer, null);
  assert.equal(data.cli.CN, undefined);
  assert.equal(data.gpr.countries.RU, undefined);
  assert.deepEqual(globalIndicatorGauges(data, 'ko', 'US').map((gauge) => gauge.value), ['확장 · 100.90', '3.76']);
  assert.equal(globalIndicatorGauges(data, 'en').length, 4);
});

test('gauge and event models show comparisons and age out old events', () => {
  const data = readGlobalIndicators(payloads.oecdCli, payloads.gpr, payloads.imfCofer, payloads.pinkSheet);
  assert.deepEqual(globalIndicatorGauges(data, 'en').map(({ value }) => value),
    ['Downturn · 99.96', '300.0 / 180.0', '56.7% · -0.24 pp YoY', '+89.3%', '+14.7%']);
  assert.deepEqual(globalIndicatorEvents(data, 'en', Date.parse('2026-11-24')).map(({ id }) => id),
    ['gpr:daily:2026-11-23', 'gpr:sustained:2026-11-23', 'cli:US:2026-10', 'pink:energy:2026-10']);
  assert.deepEqual(globalIndicatorEvents(data, 'en', Date.parse('2027-03-01')), []);
});
