import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAiSnapshot, parseAiJson, selectAiInputStories, selectIssueCountries, shouldRunAiToday, updateTrackedPairs, validateAiIssues, validateAiRelations } from '../scripts/_world-relations-ai.mjs';

const S = (id, countries, publisher = 'Reuters') => ({ id, title: `Story ${id}`, publisher, url: `https://news.example/${id}`, countries });
const KO = '러시아가 우크라이나 동부에 대규모 공습을 이어갔다';
test('daily gate uses KST and force takes precedence', () => {
  assert.deepEqual(shouldRunAiToday({ existing: null, nowMs: Date.parse('2026-11-22T20:30Z'), force: false }), { run: false, reason: 'too-early' });
  assert.deepEqual(shouldRunAiToday({ existing: null, nowMs: Date.parse('2026-11-22T21:00Z'), force: false }), { run: true, reason: 'due' });
  assert.equal(shouldRunAiToday({ existing: { date: '2026-11-23' }, nowMs: Date.parse('2026-11-22T23:00Z'), force: true }).reason, 'force');
});
test('selects linked stories and includes countries extracted from member titles', () => {
  const got = selectAiInputStories({ stories: [{ primaryTitle: 'unlinked' }, { primaryTitle: 'Overnight strikes', primarySource: 'Reuters', primaryLink: 'https://x/1', countryCodes: [], memberTitles: ['Ukraine says Russian drones hit Kyiv overnight'] }] });
  assert.equal(got.length, 1); assert.deepEqual(got[0].countries, ['RU', 'UA']);
});
test('selects issue countries by mention count and updates the 14-day pair set', () => {
  assert.deepEqual(selectIssueCountries([S(1, ['UA', 'RU']), S(2, ['UA']), S(3, ['RU', 'IR']), S(4, ['IR'])]), ['IR', 'RU', 'UA']);
  assert.deepEqual(updateTrackedPairs({ 'BR:RU': '2026-11-08', 'AR:GB': '2026-11-09' }, [{ from: 'UA', to: 'RU' }], '2026-11-22'), { 'AR:GB': '2026-11-09', 'RU:UA': '2026-11-22' });
});
test('validates grounded relations, undirected keys, and confidence by publishers', () => {
  const stories = [S(1, ['RU', 'UA']), S(2, ['RU', 'UA'], 'AP'), S(3, ['US', 'UA'], 'AP')];
  const out = validateAiRelations({ relations: [{ f: 'UA', t: 'RU', k: 'tension', d: 'military', s: KO, src: [1], c: 0.9 }, { f: 'RU', t: 'UA', k: 'tension', d: 'military', s: KO, src: [2], c: 0.8 }, { f: 'US', t: 'UA', k: 'support', d: 'politics', s: '미국이 우크라이나에 방공 무기를 지원했다', src: [3], c: 1 }] }, stories);
  assert.equal(out.relations.length, 2); assert.deepEqual(out.relations[0].id, 'ai:tension:RU-UA'); assert.equal(out.relations[0].sources.length, 2); assert.equal(out.relations[0].confidence, 0.75); assert.equal(out.relations[1].field, 'military');
});
test('validates country issues and defaults empty fields to geopolitics', () => {
  const stories = [S(1, ['UA'])];
  const out = validateAiIssues({ issues: [{ cc: 'UA', s: '우크라이나 동부 전선에서 러시아의 공세가 이어지고 방공 부족이 문제로 떠올랐다', d: ['bogus'], src: [1] }] }, stories, ['UA']);
  assert.deepEqual(out.issues[0].fields, ['geopolitics']);
});
test('parses fenced or prose-wrapped JSON and rejects unusable LLM output without calling a network', async () => {
  assert.deepEqual(parseAiJson('```json\n{"relations":[]}\n```'), { relations: [] });
  assert.deepEqual(parseAiJson('intro {"issues":[]} done'), { issues: [] });
  const pool = { stories: [{ primaryTitle: 'Russia strikes Ukraine', primarySource: 'Reuters', primaryLink: 'https://x/1', countryCodes: ['RU', 'UA'] }] };
  await assert.rejects(generateAiSnapshot({ pool, insights: null, date: '2026-11-23', nowMs: () => 0, deadlineAtMs: 1e9, callLlm: async () => null, previous: null }), (e) => e.nonRetryable === true);
});
