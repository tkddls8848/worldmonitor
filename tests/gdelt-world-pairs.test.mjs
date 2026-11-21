import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../shared/world-overview-config.json' with { type: 'json' };
import iso3 from '../shared/iso3-to-iso2.json' with { type: 'json' };
import { buildTrackedPairs, mergeWorldPairHours, parseWorldPairExport, scoreWorldPairTrends, seedFromDyadStore } from '../scripts/_gdelt-world-pairs.mjs';

const NOW = Date.parse('2026-11-22T12:20:00Z');
function row(a, b, quad, mentions = 2, goldstein = -5) {
  const fields = Array(61).fill('');
  for (const [i, v] of [[7, a], [17, b], [29, quad], [30, goldstein], [31, mentions]]) fields[i] = String(v);
  return fields.join('\t');
}
function hourlyStore({ value, trackedSinceMs = NOW - 8 * 86400000, recentHoursPresent = 24, baselineCohorts = 4 }) {
  const end = Date.parse('2026-11-22T11:00:00Z');
  const hours = {};
  for (let i = 0; i < 168; i++) {
    if (i < 24 && i >= recentHoursPresent) continue;
    const ms = end - i * 3600000;
    const key = new Date(ms).toISOString().slice(0, 13).replace(/[-T:]/g, '');
    hours[key] = { cohorts: i < 24 ? 4 : baselineCohorts, pairs: { 'RU:US': value(i) } };
  }
  return { cursor: '20261122114500', hours, trackedSince: { 'RU:US': trackedSinceMs } };
}

test('tracks 435 major pairs and recent AI pairs only inside 14 dates', () => {
  assert.equal(new Set(config.majorCountries).size, 30);
  for (const c of config.majorCountries) assert.ok(Object.values(iso3).includes(c));
  assert.equal(buildTrackedPairs(config.majorCountries, null, '2026-11-22', 14).size, 435);
  const set = buildTrackedPairs(config.majorCountries, { 'BR:RU': '2026-11-20', 'AR:GB': '2026-11-08' }, '2026-11-22', config.aiPairRetentionDays);
  assert.ok(set.has('BR:RU'));
  assert.ok(!set.has('AR:GB'));
  assert.equal(set.size, 436);
});

test('parses ISO2 event pairs and mentions-weighted conflict intensity', () => {
  assert.deepEqual(parseWorldPairExport([row('USA', 'RUS', 4, 3, -5), row('RUS', 'USA', 1), row('USA', 'USA', 4), row('USA', 'XYZ', 4), row('CHN', 'TWN', 3, 2, -2)].join('\n')),
    { 'RU:US': [1, 15], 'CN:TW': [1, 4] });
  assert.deepEqual(parseWorldPairExport(row('USA', 'RUS', 3, 2, 0)), { 'RU:US': [1, 0] });
});

test('replays are idempotent, untracked pairs are dropped, and old hours prune', () => {
  const batch = { timestamp: '20261122120000', worldPairs: { 'RU:US': [1, 15], 'AR:BR': [2, 2] } };
  const first = mergeWorldPairHours(null, [batch], new Set(['RU:US']), NOW);
  assert.deepEqual(first.hours['2026112212'], { cohorts: 1, pairs: { 'RU:US': [1, 15] } });
  assert.deepEqual(mergeWorldPairHours(first, [batch], new Set(['RU:US']), NOW).hours, first.hours);
  const aged = mergeWorldPairHours(first, [], new Set(['CN:TW']), NOW + 193 * 3600000);
  assert.deepEqual(aged.hours, {});
  assert.equal(aged.trackedSince['RU:US'], undefined);
});

test('imports configured single-country legacy dyads and skips Iran-GCC', () => {
  const seeded = seedFromDyadStore({ cursor: '20261122114500', days: { '2026-11-22': { hours: { '11': { cohorts: 4, pairs: { usa_russia: [3, 40], iran_gcc: [9, 90] } } } } } }, NOW);
  assert.deepEqual(seeded.hours['2026112211'], { cohorts: 4, pairs: { 'RU:US': [3, 40] } });
  assert.equal(seeded.cursor, '20261122114500');
});

test('scores per-day trends and waits for seven days plus minimum coverage', () => {
  const cases = [[[1, 13], 'rising', 1.3], [[1, 7], 'easing', 0.7], [[3, 30], 'surging', 3], [[1, 10], 'steady', 1]];
  for (const [recent, state, ratio] of cases) {
    const trend = scoreWorldPairTrends(hourlyStore({ value: (i) => i < 24 ? recent : [1, 10] }), NOW)['RU:US'];
    assert.equal(trend.state, state);
    assert.equal(trend.ratio, ratio);
  }
  assert.equal(scoreWorldPairTrends(hourlyStore({ value: () => [1, 10] }), NOW)['RU:US'].recentEventsPerDay, 24);
  assert.equal(scoreWorldPairTrends(hourlyStore({ trackedSinceMs: NOW - 5 * 86400000, value: () => [1, 10] }), NOW)['RU:US'].state, 'collecting');
  assert.equal(scoreWorldPairTrends(hourlyStore({ recentHoursPresent: 11, value: () => [1, 10] }), NOW)['RU:US'].state, 'collecting');
  assert.equal(scoreWorldPairTrends(hourlyStore({ baselineCohorts: 2, value: (i) => i < 24 ? [1, 10] : [0.5, 5] }), NOW)['RU:US'].state, 'steady');
});
