import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWorldSnapshot } from '../src/services/world-overview.ts';
import { buildWorldMapView, buildCountryDrawerData, fillLevelFor, filterDrawerRelations } from '../src/services/world-overview-view.ts';
import type { WorldOverviewSnapshot } from '../shared/world-overview.js';

const stored = {
  schemaVersion: 1, date: '2026-11-22', generatedAt: 12,
  countries: { US: { level: 'war', deaths: null, cii: { score: 60, unrest: 50 }, demonstrations: null, unrest: true, blocs: ['x'], inNews: false, issue: { summaryKo: 'issue', fields: ['politics'], sources: [] } }, KR: { level: null, unrest: false, blocs: [], inNews: false, issue: null } },
  relations: [{ id: 'r1', origin: 'fixed', kind: 'tension', field: 'geopolitics', from: 'US', to: 'KR', directed: true, score: 10, value: 1, label: '긴장', sources: [], trend: { state: 'rising', recentEventsPerDay: 2, baselineEventsPerDay: 1, recentIntensityPerDay: 2, baselineIntensityPerDay: 1, ratio: 2, trackedSince: 1 } }],
  blocs: [{ id: 'x', nameKo: '블록', nameEn: 'Bloc', members: ['US'], source: { url: 'https://example.com', title: 'source', publisher: 'pub' } }], anchors: { US: [-100, 40], KR: [127, 37] }, ai: { status: 'ok', date: '2026-11-22', model: 'test' }, inputs: {}, availableDates: ['2026-11-22'],
};

test('normalizes stored and RPC snapshots, including optional proto fields', () => {
  const normalized = normalizeWorldSnapshot(stored);
  assert.deepEqual(normalized?.anchors.US, [-100, 40]);
  assert.equal(normalized?.countries.US.deaths, null);
  const rpc = structuredClone(stored) as Record<string, any>;
  rpc.anchors.US = { longitude: -100, latitude: 40 };
  rpc.countries.US = { ...rpc.countries.US, deaths: undefined, hasDemonstrations: false, demonstrations: 0 };
  rpc.relations[0].trend = { ...rpc.relations[0].trend, hasBaselineEventsPerDay: false, baselineEventsPerDay: 0, hasRatio: false, ratio: 0 };
  const normalizedRpc = normalizeWorldSnapshot(rpc);
  assert.deepEqual(normalizedRpc?.anchors.US, [-100, 40]);
  assert.equal(normalizedRpc?.countries.US.deaths, null);
  assert.equal(normalizedRpc?.relations[0].trend?.baselineEventsPerDay, null);
  assert.equal(normalizeWorldSnapshot({}), null);
});

test('builds field-aware map and drawer data with fill mapping and filters', () => {
  assert.deepEqual(['war', 'high', 'medium', 'tension', 'issue', null].map((fill) => fillLevelFor(fill as never)), [4, 3, 2, 1, 1, 0]);
  const snapshot = normalizeWorldSnapshot(stored)!;
  const view = buildWorldMapView(snapshot, ['military', 'geopolitics'], null);
  assert.equal(view.countries.US.level, 4);
  assert.equal(view.countries.US.unrestOutline, false);
  assert.equal(view.lines[0].showTag, true);
  assert.deepEqual(buildWorldMapView(snapshot, ['geopolitics'], null).countries.US.level, null);
  const drawer = buildCountryDrawerData(snapshot, 'US', '2026-11-22');
  assert.equal(drawer.isToday, true);
  assert.equal(drawer.issue?.summaryKo, 'issue');
  assert.equal(drawer.relations[0].counterpartIso2, 'KR');
  assert.deepEqual(filterDrawerRelations(drawer.relations, 'worsening').map((r) => r.id), ['r1']);
  assert.deepEqual(filterDrawerRelations(drawer.relations, 'easing'), []);
  assert.equal(buildCountryDrawerData(snapshot, 'ZZ', '2026-11-22').nameKo, 'ZZ');
});
