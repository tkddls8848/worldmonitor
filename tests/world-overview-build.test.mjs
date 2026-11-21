import assert from 'node:assert/strict';
import { test } from 'node:test';
import config from '../shared/world-overview-config.json' with { type: 'json' };
import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../shared/bootstrap-tier-keys.js';
import { WORLD_OVERVIEW_KEYS } from '../shared/world-overview.js';
import { buildRelationLines, buildWorldOverviewSnapshot, conflictLevel, formatUsdKo, isValidSnapshot, monthlyDeaths, nextAvailableDates } from '../scripts/_world-overview-build.mjs';
import { readBuildInputs } from '../scripts/seed-world-overview.mjs';
import { getWorldOverviewSnapshot } from '../server/worldmonitor/world-overview/v1/get-world-overview-snapshot.ts';

const NOW = Date.parse('2026-11-23T03:00:00Z');
const CITATIONS = config.citations;
const EMPTY = { relations: null, trends: null, ai: null, ucdpEvents: null, hapi: {}, cii: null, pool: null };
const OPTS = { date: '2026-11-23', nowMs: NOW, marks: null, previousDates: null, config };
const RELATIONS = { generatedAt: NOW, alliances: { bilateral: [{ id: 'us-jp', a: 'US', b: 'JP', nameKo: '미·일 안전보장조약', since: 1960, source: { url: 'https://s/a', title: 'Treaty', publisher: 'UN' } }], blocs: [] }, sanctions: { pairs: [{ issuer: 'US', target: 'RU', count: 812, source: 'opensanctions' }, { issuer: 'UN', target: 'KP', count: 151, source: 'opensanctions' }] }, economic: { trade: [{ from: 'SA', to: 'KR', valueUsd: 25740855840 }], bankClaims: [{ from: 'JP', to: 'AU', valueUsd: 155381200000 }] } };
const TRENDS = { generatedAt: NOW, trends: { 'JP:US': { state: 'steady', recentEventsPerDay: 2, recentIntensityPerDay: 12 }, 'CN:US': { state: 'surging', recentEventsPerDay: 34.2, recentIntensityPerDay: 500 }, 'RU:UA': { state: 'collecting', recentEventsPerDay: 9, recentIntensityPerDay: 10 } } };
const AI = { date: '2026-11-23', generatedAt: NOW, model: 'fixture', relations: [{ kind: 'support', from: 'US', to: 'UA', field: 'military', summaryKo: '지원 관계 설명', confidence: 0.5, sources: [{ url: 'https://s/1', title: 'S', publisher: 'Source' }] }], issues: [] };

test('classifies conflict levels and combines monthly deaths', () => {
  assert.deepEqual([1000, 100, 25, 10, 9].map((n) => conflictLevel(n, null)), ['war', 'high', 'medium', 'tension', null]);
  assert.equal(conflictLevel(9, 50), 'tension');
  assert.equal(formatUsdKo(25740855840), '$25.7B');
  assert.deepEqual(monthlyDeaths({ ucdp: { referenceMonth: '2026-10', conflicts: [{ code: 'UA', deaths: 3000 }] }, hapi: { UA: { conflictFatalities: 4771, referencePeriod: '2026-10-01' } } }).UA, { count: 4771, source: 'hapi', month: '2026-10' });
});

test('builds fixed, trend, and AI relation lines from existing payloads', () => {
  const lines = buildRelationLines({ relations: RELATIONS, trends: TRENDS, ai: AI, citations: CITATIONS });
  const byId = Object.fromEntries(lines.map((line) => [line.id, line]));
  assert.equal(byId['fixed:alliance:JP-US'].label, '미·일 안전보장조약');
  assert.equal(byId['fixed:alliance:JP-US'].trend.state, 'steady');
  assert.equal(byId['fixed:sanction:US>RU'].score, 1);
  assert.ok(byId['fixed:sanction:UN>KP']);
  assert.equal(byId['fixed:economic.trade:SA>KR'].label, '전략 품목 수입 $25.7B');
  assert.equal(byId['fixed:economic.bank:JP>AU'].label, '은행 대외 채권 $155.4B');
  assert.equal(byId['fixed:tension:CN-US'].label, '충돌 사건 하루 34건');
  assert.equal(byId['fixed:tension:RU-UA'], undefined);
  assert.equal(byId['ai:support:US>UA'].score, 1.5);
});

test('publishes usable HAPI-only snapshot and handler returns the builder fixture', async () => {
  const snapshot = buildWorldOverviewSnapshot({ ...EMPTY, hapi: { UA: { conflictFatalities: 4771, conflictDemonstrations: 15, referencePeriod: '2026-10-01' } } }, OPTS);
  assert.equal(isValidSnapshot(snapshot), true);
  assert.equal(snapshot.countries.UA.level, 'war');
  assert.deepEqual(snapshot.relations, []);
  assert.equal(snapshot.inputs.relations.status, 'missing');
  assert.equal(snapshot.inputs.hapi.status, 'ok');
  const response = await getWorldOverviewSnapshot({}, { date: OPTS.date }, { now: () => NOW, readJson: async (key) => key === WORLD_OVERVIEW_KEYS.snapshot ? snapshot : key === WORLD_OVERVIEW_KEYS.dates ? [] : null });
  assert.deepEqual(response.snapshot, snapshot);
  assert.deepEqual(response.archivedDates, []);
});

test('handles AI freshness, marks, unrest, and archive window', () => {
  const yesterday = buildWorldOverviewSnapshot({ ...EMPTY, ai: { ...AI, date: '2026-11-22' } }, OPTS);
  const older = buildWorldOverviewSnapshot({ ...EMPTY, ai: { ...AI, date: '2026-11-21' } }, OPTS);
  assert.equal(yesterday.ai.status, 'stale');
  assert.equal(older.ai.status, 'missing');
  const marked = buildWorldOverviewSnapshot({ ...EMPTY, ai: AI }, { ...OPTS, marks: { updatedAt: NOW, marks: [{ id: 'rel', type: 'relation', date: OPTS.date, matchKey: 'support:US>UA', sourceUrls: ['https://s/1'], summaryKo: '지원 관계 설명', markedAt: NOW }] } });
  assert.equal(marked.relations.find((line) => line.id === 'ai:support:US>UA').mark.state, 'hidden');
  const snapshot = buildWorldOverviewSnapshot({ ...EMPTY, ai: AI, cii: { asOf: NOW, scores: [{ region: 'FR', combinedScore: 4, components: { ciiContribution: 40 } }] }, pool: { stories: [{ countryCodes: ['DK'] }, { countryCodes: ['DK', 'RU'] }, { countryCodes: ['RU'] }] } }, OPTS);
  assert.equal(snapshot.ai.status, 'ok');
  assert.equal(snapshot.countries.FR.unrest, true);
  assert.equal(snapshot.countries.DK.inNews, true);
  assert.deepEqual(nextAvailableDates(['2026-08-24', '2026-08-25', '2026-11-22'], '2026-11-22'), ['2026-08-25', '2026-11-22']);
  assert.equal(isValidSnapshot({ ...snapshot, relations: [{ id: 'x'.repeat(300_000) }] }), false);
  assert.equal(BOOTSTRAP_CACHE_KEYS.worldOverview, WORLD_OVERVIEW_KEYS.snapshot);
  assert.equal(BOOTSTRAP_TIERS.worldOverview, 'on-demand');
});

test('fetches CII scores through the supplied personal API fallback', async () => {
  let calls = 0;
  const inputs = await readBuildInputs({ readValue: async () => null, readHapi: async () => ({}), nowMs: NOW, fetchCii: async () => { calls++; return { ciiScores: [{ region: 'IR', combinedScore: 50, components: { ciiContribution: 0 }, computedAt: NOW }] }; } });
  assert.equal(calls, 1);
  assert.equal(inputs.cii.scores[0].region, 'IR');
});
