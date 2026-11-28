import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBattleView, buildCountryEventMarkers, impactFreshness, impactTrend, filterImpactWindow, pressureLevel } from '../src/services/battle-map-view';
import type { ImpactLink } from '../src/services/impact-links';
import { IMPACT_DAY_MS as DAY } from '../shared/impact-links';

const now = Date.parse('2026-11-28T00:00:00Z');
const link = (id: string, patch: Partial<ImpactLink> = {}): ImpactLink => ({
  id, actor: 'US', target: 'KR', kind: 'tariffs', direction: 'pressure', magnitude: 56, trend: 'new',
  firstSeen: now, lastSeen: now, headline: '', undirected: false, evidence: [], ...patch,
});
const anchors: Record<string, [number, number]> = { US: [-100, 40], KR: [128, 37], UA: [31, 48] };

test('ages a delayed conflict by the dated evidence and excludes it from 24h and 신규', () => {
  const old = link('old', { kind: 'conflict', lastSeen: now - 22 * DAY });
  assert.equal(impactFreshness(old.lastSeen, now), 0.32);
  assert.equal(impactTrend(old, now), '');
  assert.deepEqual(filterImpactWindow([old], '24h', now), []);
  assert.deepEqual(filterImpactWindow([old], '7d', now), [old]);
});

test('bundles related lines and preserves every link in the ranked list and pressure score', () => {
  const tariffs = link('tariffs');
  const conflict = link('conflict', { kind: 'conflict', magnitude: 100, lastSeen: now - 22 * DAY });
  const support = link('support', { kind: 'support', direction: 'support', actor: 'KR', target: 'UA', undirected: true, magnitude: 85 });
  const tension = link('tension', { kind: 'tension', actor: 'UA', undirected: true, magnitude: 85 });
  const view = buildBattleView([tariffs, conflict, support, tension], anchors, now, null, null);
  assert.equal(view.arcs.length, 3);
  assert.deepEqual(view.arcs.find((arc) => arc.link === tariffs)?.bundle, [tariffs, conflict]);
  assert.equal(view.ranked.length, 4);
  assert.equal(view.pressure.KR, 88);
  assert.equal(pressureLevel(view.pressure.KR), 4);
  assert.equal(view.pressure.UA, undefined);
  assert.deepEqual(view.crests.map(({ code, count }) => [code, count]), [['US', 2]]);
  assert.equal(view.arcs.find((arc) => arc.link === support)?.animated, false);
  const selected = buildBattleView([tariffs, conflict, support, tension], anchors, now, 'KR', null);
  assert.equal(selected.arcs.length, 4);
  assert.ok(selected.arcs.every((arc) => arc.opacity === 1));
  assert.deepEqual(buildCountryEventMarkers([
    { id: 'country:conflict:KR', country: 'KR', kind: 'conflict', magnitude: 30, lastSeen: now, eventCount: 3, evidence: [] },
    { id: 'country:energy:KR', country: 'KR', kind: 'energy', magnitude: 10, lastSeen: now, eventCount: 1, evidence: [] },
  ], anchors).map(({ at, offset }) => [at, offset]), [[anchors.KR, 0], [anchors.KR, 13]]);
});

test('keeps the initial map readable and promotes a selected link beyond the map cap', () => {
  const links = Array.from({ length: 20 }, (_, i) => link(String(i), { actor: `C${i}`, magnitude: 100 - i }));
  const points = { ...anchors, ...Object.fromEntries(links.map(({ actor }, index) => [actor, [index, 0]])) };
  const view = buildBattleView(links, points, now, null, null);
  assert.equal(view.arcs.length, 14);
  assert.equal(view.ranked.length, 20);
  assert.equal(view.arcs.filter((arc) => arc.animated).length, 8);
  const selected = buildBattleView(links, points, now, null, links[19]!);
  assert.equal(selected.arcs.at(-1)?.link, links[19]);
});
