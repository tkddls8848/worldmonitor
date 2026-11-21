import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIssuesPrompt, buildRelationsPrompt, callLlmViaInsights, generateAiSnapshot, parseAiJson, selectAiInputStories, selectIssueCountries, shouldRunAiToday, updateTrackedPairs, validateAiIssues, validateAiRelations } from '../scripts/_world-relations-ai.mjs';
import { declareRecords as declareAiRecords } from '../scripts/seed-world-relations-ai.mjs';
import { __setInsightsLlmTransportForTests } from '../scripts/seed-insights.mjs';

const S = (id, countries, publisher = 'Reuters') => ({ id, title: `Story ${id}`, publisher, url: `https://news.example/${id}`, countries });
const KO = '러시아가 우크라이나 동부에 대규모 공습을 이어갔다';
test('daily gate uses KST and force takes precedence', () => {
  assert.deepEqual(shouldRunAiToday({ existing: null, nowMs: Date.parse('2026-11-22T20:30Z'), force: false }), { run: false, reason: 'too-early' });
  assert.deepEqual(shouldRunAiToday({ existing: null, nowMs: Date.parse('2026-11-22T21:00Z'), force: false }), { run: true, reason: 'due' });
  assert.equal(shouldRunAiToday({ existing: { date: '2026-11-23' }, nowMs: Date.parse('2026-11-22T23:00Z'), force: true }).reason, 'force');
});
test('AI seeder exports its runSeed record counter', () => {
  assert.equal(declareAiRecords({ relations: [{}, {}], issues: [{}] }), 3);
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
test('drops ungrounded, unknown-kind, English, URL, and uncited relations', () => {
  const stories = [S(1, ['RU', 'UA'])];
  const rejected = [
    { f: 'US', t: 'UA', k: 'tension', d: 'military', s: KO, src: [1] },
    { f: 'RU', t: 'UA', k: 'mystery', d: 'military', s: KO, src: [1] },
    { f: 'RU', t: 'UA', k: 'tension', d: 'military', s: 'Russia attacks Ukraine', src: [1] },
    { f: 'RU', t: 'UA', k: 'tension', d: 'military', s: '러시아가 우크라이나를 공격했다 https://x.test', src: [1] },
    { f: 'RU', t: 'UA', k: 'tension', d: 'military', s: KO, src: [] },
    { f: 'RU', t: 'UA', k: 'tension', d: 'military', s: KO, src: [99] },
  ];
  const out = validateAiRelations({ relations: rejected }, stories);
  assert.equal(out.relations.length, 0);
  assert.equal(out.dropped, rejected.length);
});
test('rejects unrequested or too-short issues and reports dropped count', () => {
  const stories = [S(1, ['UA'])];
  const out = validateAiIssues({ issues: [
    { cc: 'RU', s: '러시아 요약은 충분히 길고 출처에도 연결된다', d: [], src: [1] },
    { cc: 'UA', s: '짧다', d: [], src: [1] },
  ] }, stories, ['UA']);
  assert.equal(out.issues.length, 0);
  assert.equal(out.dropped, 2);
});
test('builds numbered story prompts without URLs and strips markers from the world brief', () => {
  const stories = [{ ...S(1, ['RU', 'UA']), title: 'Headline' }];
  const rel = buildRelationsPrompt(stories, '2026-11-23', 'brief [3] retained [12]');
  const issue = buildIssuesPrompt(stories, ['UA'], '2026-11-23');
  assert.match(rel.userPrompt, /1\. \[RU,UA\] Headline/);
  assert.match(rel.userPrompt, /brief {2}retained/);
  assert.doesNotMatch(`${rel.systemPrompt}\n${rel.userPrompt}\n${issue.systemPrompt}\n${issue.userPrompt}`, /https?:\/\//);
  assert.match(issue.userPrompt, /1\. \[RU,UA\] Headline/);
});
test('caps the input story list at 60 and already-done gate skips the injected caller', async () => {
  const rows = Array.from({ length: 70 }, (_, i) => ({ primaryTitle: `Story ${i}`, primarySource: 'Reuters', primaryLink: `https://x/${i}`, countryCodes: ['UA', 'RU'] }));
  assert.equal(selectAiInputStories({ stories: rows }).length, 60);
  const gate = shouldRunAiToday({ existing: { date: '2026-11-23' }, nowMs: Date.parse('2026-11-22T21:00Z'), force: false });
  assert.deepEqual(gate, { run: false, reason: 'already-done' });
});
test('deadline exhaustion publishes a partial day when an earlier injected call succeeded', async () => {
  const pool = { stories: [
    { primaryTitle: 'Russia strikes Ukraine', primarySource: 'Reuters', primaryLink: 'https://x/1', countryCodes: ['RU', 'UA'] },
    { primaryTitle: 'Ukraine responds', primarySource: 'AP', primaryLink: 'https://x/2', countryCodes: ['UA'] },
    { primaryTitle: 'Ukraine reports damage', primarySource: 'BBC', primaryLink: 'https://x/3', countryCodes: ['UA'] },
  ] };
  let now = 0;
  const calls = [];
  const result = await generateAiSnapshot({ pool, insights: { worldBrief: 'brief [2]' }, date: '2026-11-23', nowMs: () => now, deadlineAtMs: 50_000, previous: null,
    callLlm: async (prompt, options) => { calls.push({ prompt, options }); const text = JSON.stringify({ relations: [{ f: 'RU', t: 'UA', k: 'tension', d: 'military', s: '러시아와 우크라이나의 교전이 계속되고 있다', src: [1], c: 0.9 }] }); options.accept(text); now = 25_000; return { text, provider: 'ollama', model: 'test' }; },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.maxTokens, 1500);
  assert.equal(result.status, 'partial');
  assert.equal(result.relations.length, 1);
  assert.equal(result.diagnostics.calls.at(-1).ok, false);
});
test('uses the existing insights provider chain through its injectable transport', async () => {
  const oldUrl = process.env.OLLAMA_API_URL;
  process.env.OLLAMA_API_URL = 'http://ollama.test';
  let requested;
  __setInsightsLlmTransportForTests({ fetch: async (url) => {
    requested = url;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"relations":[],"padding":"sufficiently long fixture output"}' } }] }), { status: 200 });
  } });
  try {
    const result = await callLlmViaInsights({ systemPrompt: 'system', userPrompt: 'user' }, { maxTokens: 1, callBudgetMs: 10_000, accept: () => true });
    assert.equal(requested, 'http://ollama.test/v1/chat/completions');
    assert.equal(result.provider, 'ollama');
  } finally {
    __setInsightsLlmTransportForTests(null);
    if (oldUrl === undefined) delete process.env.OLLAMA_API_URL;
    else process.env.OLLAMA_API_URL = oldUrl;
  }
});
test('parses fenced or prose-wrapped JSON and rejects unusable LLM output without calling a network', async () => {
  assert.deepEqual(parseAiJson('```json\n{"relations":[]}\n```'), { relations: [] });
  assert.deepEqual(parseAiJson('intro {"issues":[]} done'), { issues: [] });
  assert.equal(parseAiJson('not json at all'), null);
  const pool = { stories: [{ primaryTitle: 'Russia strikes Ukraine', primarySource: 'Reuters', primaryLink: 'https://x/1', countryCodes: ['RU', 'UA'] }] };
  await assert.rejects(generateAiSnapshot({ pool, insights: null, date: '2026-11-23', nowMs: () => 0, deadlineAtMs: 1e9, callLlm: async () => null, previous: null }), (e) => e.nonRetryable === true);
});
