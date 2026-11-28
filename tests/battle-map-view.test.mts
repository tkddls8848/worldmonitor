import assert from 'node:assert/strict';
import { test } from 'node:test';
import { battleCountryLabels, battleEndpoint, battleStoryLabel, buildBattleView, buildCountryEventMarkers, impactFreshness, impactTrend, filterImpactWindow, pressureLevel } from '../src/services/battle-map-view';
import type { ImpactLink } from '../src/services/impact-links';
import { battleCurve } from '../src/components/world/BattleMapOverlay';
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

test('shows a representative arc and preserves every link in the ranked list and pressure score', () => {
  const tariffs = link('tariffs');
  const conflict = link('conflict', { kind: 'conflict', magnitude: 100, lastSeen: now - 22 * DAY });
  const support = link('support', { kind: 'support', direction: 'support', actor: 'KR', target: 'UA', undirected: true, magnitude: 85 });
  const tension = link('tension', { kind: 'tension', actor: 'UA', undirected: true, magnitude: 85 });
  const view = buildBattleView([tariffs, conflict, support, tension], anchors, now, null, null);
  assert.equal(view.arcs.length, 2);
  assert.ok(view.arcs.some((arc) => arc.link === tariffs));
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

test('caps the map, prioritizes Korea, and diversifies kinds and unordered pairs', () => {
  const links = Array.from({ length: 20 }, (_, i) => link(String(i), { actor: `C${i}`, target: 'US', magnitude: 100 - i }));
  const points = { ...anchors, ...Object.fromEntries(links.map(({ actor }, index) => [actor, [index, 0]])) };
  const korea = link('korea', { magnitude: 4 });
  const reverse = link('reverse', { actor: 'KR', target: 'US', kind: 'sanctions', magnitude: 3 });
  const energy = link('energy', { actor: 'UA', target: 'US', kind: 'energy', magnitude: 2 });
  const items = [...links, reverse, energy, korea];
  const view = buildBattleView(items, points, now, null, null);
  assert.equal(view.arcs.length, 6);
  assert.equal(view.ranked.length, 23);
  assert.equal(view.arcs.at(-1)?.link, korea);
  assert.ok(view.arcs.some((arc) => arc.link === energy));
  assert.ok(!view.arcs.some((arc) => arc.link === reverse));
  const selected = buildBattleView(items, points, now, null, links[19]!);
  assert.equal(selected.arcs.at(-1)?.link, links[19]);
  assert.equal(selected.arcs.filter((arc) => arc.emphasized).length, 1);
  const filtered = buildBattleView(items, points, now, null, null, true);
  assert.equal(filtered.arcs.length, 23);
  assert.equal(filtered.arcs.filter((arc) => arc.animated).length, 8);
});

test('labels every visible endpoint once, including Korea when no stories are available', () => {
  const korea = { code: 'KR', at: [126.98, 37.57] };
  assert.deepEqual(battleCountryLabels([], {}), [korea]);
  const view = buildBattleView([link('tariffs')], anchors, now, null, null);
  assert.deepEqual(battleCountryLabels(view.arcs, anchors), [korea, { code: 'US', at: anchors.US }]);
  assert.deepEqual(battleEndpoint('RU', { RU: [100, 60] }), [37.62, 55.75]);
  assert.equal(battleStoryLabel(link('tariffs'), 'tariffs'), '미국 → 한국 관세');
  assert.equal(pressureLevel(0), 0);
  assert.equal(pressureLevel(1), 1);
});

test('curves reciprocal links away from each other and ends each arrow at its target', () => {
  const from = { x: 30, y: 20 };
  const to = { x: 50, y: 20 };
  const forward = battleCurve(from, to, 3, 0, true);
  const reverse = battleCurve(to, from, 3, 0, true);
  assert.ok(forward.pointAt(0.5).y < from.y - 8);
  assert.ok(reverse.pointAt(0.5).y > from.y + 8);
  assert.deepEqual([forward.x, forward.y], [to.x, to.y]);
  assert.deepEqual([reverse.x, reverse.y], [from.x, from.y]);
});
