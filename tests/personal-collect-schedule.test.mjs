// collect:personal is the only scheduler in the personal setup: a seeder it does
// not list never runs, and its dataset stays empty on the dashboard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN, collectorScript, collectorWatchGroups, dueCollectors,
} from '../scripts/personal-collect.mjs';

const SCRIPTS = fileURLToPath(new URL('../scripts/', import.meta.url));

test('the snapshot builder runs last, after every input collector', () => assert.equal(DEFAULT_COLLECTORS.at(-1), 'world-overview'));

test('every default collector resolves to a script, once', () => {
  for (const name of DEFAULT_COLLECTORS) assert.doesNotThrow(() => collectorScript(name), name);
  assert.equal(new Set(DEFAULT_COLLECTORS).size, DEFAULT_COLLECTORS.length);
});

test('every bundle is collected', () => {
  const bundles = readdirSync(SCRIPTS).filter((f) => /^seed-bundle-.*\.mjs$/.test(f)).map((f) => f.slice(5, -4));
  assert.deepEqual(bundles.filter((b) => !DEFAULT_COLLECTORS.includes(b)), []);
});

test('watch keeps relay feeds on their own cadence even during a slow bulk pass', () => {
  const [news, shipping, transit, bulk] = collectorWatchGroups(DEFAULT_COLLECTORS, 15, false);
  assert.deepEqual(news, { names: ['news-digest', 'news-threat-summary'], every: 15, force: true, fixedCadence: true });
  assert.deepEqual(shipping, { names: ['shipping-stress'], every: 15, force: true, fixedCadence: true });
  assert.deepEqual(transit, { names: ['transit-summaries'], every: 10, force: true, fixedCadence: true });
  assert.equal(bulk.names.at(-1), 'world-overview');
  const scheduled = [news, shipping, transit, bulk].flatMap((group) => group.names);
  assert.equal(scheduled.length, DEFAULT_COLLECTORS.length);
  assert.deepEqual(new Set(scheduled), new Set(DEFAULT_COLLECTORS));
  assert.deepEqual(collectorWatchGroups(['hormuz'], 7, true), [{ names: ['hormuz'], every: 7, force: true }]);
});

test('the GPS interference feed is collected through its fetch script', () => {
  assert.match(collectorScript('gpsjam'), /fetch-gpsjam\.mjs$/);
  assert.ok(DEFAULT_COLLECTORS.includes('gpsjam'));
});

test('the fixed relations collector runs daily', () => assert.equal(STANDALONE_INTERVAL_MIN['world-relations'], 1440));

test('the pizza index collector still finds the relay blocks it runs', () => {
  assert.ok(DEFAULT_COLLECTORS.includes('pizzint'));
  const relay = readFileSync(new URL('../scripts/ais-relay.cjs', import.meta.url), 'utf8');
  const seeder = readFileSync(collectorScript('pizzint'), 'utf8');
  const markers = [...seeder.matchAll(/relayBlock\('([^']+)', '([^']+)'\)/g)];
  assert.equal(markers.length, 3);
  for (const [, start, end] of markers) {
    const from = relay.indexOf(start);
    assert.ok(from >= 0 && relay.indexOf(end, from) > from, `${start} … ${end}`);
  }
});

test('the AI relations collector runs right after insights', () => {
  assert.equal(DEFAULT_COLLECTORS.indexOf('world-relations-ai'), DEFAULT_COLLECTORS.indexOf('insights') + 1);
});

test('a standalone collector waits out its interval; others run every pass', () => {
  const now = 10 * 24 * 60 * 60_000;
  const every = STANDALONE_INTERVAL_MIN['fear-greed'] * 60_000;
  const names = ['earthquakes', 'fear-greed'];
  assert.deepEqual(dueCollectors(names, {}, now), names);
  assert.deepEqual(dueCollectors(names, { 'fear-greed': now - every + 1, earthquakes: now }, now), ['earthquakes']);
  assert.deepEqual(dueCollectors(names, { 'fear-greed': now - every }, now), names);
});
