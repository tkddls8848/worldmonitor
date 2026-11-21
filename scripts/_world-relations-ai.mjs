import { extractFirstJsonObject } from './_llm-json.mjs';
import { extractStoryCountries } from './shared/geo-extract.mjs';
import iso2ToIso3 from '../shared/iso2-to-iso3.json' with { type: 'json' };
import { addDays, AI_RELATION_KINDS, KIND_DEFAULT_FIELD, WORLD_FIELDS, kstDate, kstHour, pairKey, relationMatchKey } from '../shared/world-overview.js';

export const AI_LIMITS = Object.freeze({ stories: 60, relations: 20, issueCountries: 20, issueBatch: 5, minMentions: 2, relationMaxChars: 80, issueMinChars: 20, issueMaxChars: 300, callBudgetMs: 55_000, minCallMs: 20_000 });
const iso2s = new Set(Object.keys(iso2ToIso3));
const isUrl = (s) => /^https?:\/\//i.test(s ?? '');
const isKorean = (s) => /[가-힣]/u.test(s ?? '');
const sourceFor = (story) => ({ url: story.url, title: story.title, publisher: story.publisher, ...(Number.isFinite(story.publishedAt) ? { publishedAt: story.publishedAt } : {}) });

export const callLlmViaInsights = (p, o) => import('./seed-insights.mjs').then(({ callLLM }) => callLLM(null, { systemPrompt: p.systemPrompt, userPrompt: p.userPrompt, ...o }));

export function shouldRunAiToday({ existing, nowMs, force }) {
  if (force) return { run: true, reason: 'force' };
  if (existing?.date === kstDate(nowMs)) return { run: false, reason: 'already-done' };
  if (kstHour(nowMs) < 6) return { run: false, reason: 'too-early' };
  return { run: true, reason: 'due' };
}

export function selectAiInputStories(pool) {
  const rows = Array.isArray(pool?.stories) ? pool.stories : [];
  const out = [];
  for (const row of rows) {
    const title = typeof row?.primaryTitle === 'string' ? row.primaryTitle.trim() : '';
    if (!title || !isUrl(row.primaryLink)) continue;
    const countries = new Set((Array.isArray(row.countryCodes) ? row.countryCodes : []).filter((cc) => iso2s.has(cc)));
    for (const member of Array.isArray(row.memberTitles) ? row.memberTitles : []) for (const cc of extractStoryCountries(member).countryCodes) countries.add(cc);
    out.push({ id: out.length + 1, title, publisher: String(row.primarySource ?? ''), url: row.primaryLink, ...(Number.isFinite(row.pubDate) ? { publishedAt: row.pubDate } : {}), countries: [...countries].sort() });
    if (out.length === AI_LIMITS.stories) break;
  }
  return out;
}

export function selectIssueCountries(stories) {
  const counts = new Map();
  for (const s of stories) for (const cc of new Set(s.countries)) counts.set(cc, (counts.get(cc) ?? 0) + 1);
  return [...counts].filter(([, n]) => n >= AI_LIMITS.minMentions).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, AI_LIMITS.issueCountries).map(([cc]) => cc);
}

function stripMarkers(text) { return String(text ?? '').replace(/\[\d+\]/g, '').trim(); }
function storiesText(stories) { return stories.map((s) => `${s.id}. [${s.countries.join(',')}] ${s.title} — ${s.publisher}`).join('\n'); }
const commonSystem = '당신은 국제 뉴스 분석가입니다. 번호가 붙은 기사만 사용하고 인용은 src에 기사 번호로 표시하세요. URL은 절대 쓰지 마세요. s는 한국어로 쓰고, 고유명사는 확실하지 않으면 원문 표기를 유지하세요. 인용 기사가 명시하거나 분명히 뒷받침하는 내용만 포함하세요. JSON 객체 하나만 답하고 설명문이나 코드펜스는 쓰지 마세요.';
export function buildRelationsPrompt(stories, date, worldBrief) {
  return { systemPrompt: `${commonSystem} 관계는 support(지원), sanction(제재), alliance(동맹), tension(긴장) 중 선택합니다. d는 military, diplomacy, geopolitics, finance 중 선택합니다. 관계 요약은 4~60자이며 최대 20개입니다. 형식: {"relations":[{"f":"US","t":"UA","k":"support","d":"military","s":"…","src":[3],"c":0.8}]}`, userPrompt: [`날짜: ${date}`, worldBrief ? `오늘의 요약(참고용): ${stripMarkers(worldBrief)}` : '', storiesText(stories)].filter(Boolean).join('\n') };
}
export function buildIssuesPrompt(stories, countries, date) {
  const wanted = new Set(countries);
  const relevant = stories.filter((s) => s.countries.some((cc) => wanted.has(cc)));
  return { systemPrompt: `${commonSystem} 국가별 요약은 20~180자이며 요청된 나라당 하나만 작성합니다. d는 military, diplomacy, geopolitics, politics, finance의 배열입니다. 형식: {"issues":[{"cc":"UA","s":"…","d":["military"],"src":[3]}]}`, userPrompt: [`날짜: ${date}`, `대상 국가: ${countries.join(', ')}`, storiesText(relevant)].join('\n') };
}
export function parseAiJson(text) {
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { /* extract below */ }
  const candidate = extractFirstJsonObject(text);
  try { return candidate ? JSON.parse(candidate) : null; } catch { return null; }
}
function citedStories(raw, byId) {
  if (!Array.isArray(raw)) return [];
  const ids = raw.map((n) => typeof n === 'string' && /^S\d+$/.test(n) ? Number(n.slice(1)) : Number(n));
  return [...new Set(ids)].map((id) => byId.get(id)).filter(Boolean);
}
function confidence(modelConfidence, stories) {
  const c = Number.isFinite(modelConfidence) && modelConfidence >= 0 && modelConfidence <= 1 ? modelConfidence : 0.5;
  const publishers = new Set(stories.map((s) => s.publisher).filter(Boolean)).size;
  return Math.min(c, [0, 0.5, 0.75, 1][Math.min(3, publishers)]);
}
function mergeSources(a, b) { return [...new Map([...a, ...b].map((s) => [s.url, s])).values()].slice(0, 5); }

export function validateAiRelations(parsed, stories) {
  let dropped = 0;
  const byId = new Map(stories.map((s) => [s.id, s]));
  const map = new Map();
  for (const raw of Array.isArray(parsed?.relations) ? parsed.relations : []) {
    const from = raw?.f, to = raw?.t, kind = raw?.k;
    if (!iso2s.has(from) || !iso2s.has(to) || from === to || !AI_RELATION_KINDS.includes(kind)) { dropped++; continue; }
    const cited = citedStories(raw.src, byId);
    const summary = String(raw.s ?? '').trim();
    if (!cited.length || !cited.some((s) => s.countries.includes(from)) || !cited.some((s) => s.countries.includes(to)) || summary.length < 4 || summary.length > AI_LIMITS.relationMaxChars || !isKorean(summary) || /https?:/i.test(summary)) { dropped++; continue; }
    let a = from, b = to;
    if (!['support', 'sanction'].includes(kind) && a > b) [a, b] = [b, a];
    const field = WORLD_FIELDS.includes(raw.d) && raw.d !== 'politics' ? raw.d : KIND_DEFAULT_FIELD[kind];
    const modelConfidence = Number.isFinite(raw.c) && raw.c >= 0 && raw.c <= 1 ? raw.c : 0.5;
    const item = { id: `ai:${relationMatchKey({ kind, from: a, to: b })}`, from: a, to: b, kind, directed: ['support', 'sanction'].includes(kind), field, summaryKo: summary, confidence: confidence(modelConfidence, cited), sources: cited.map(sourceFor), _modelConfidence: modelConfidence };
    const old = map.get(item.id);
    if (!old) map.set(item.id, item);
    else { old.sources = mergeSources(old.sources, item.sources); old._modelConfidence = Math.max(old._modelConfidence, item._modelConfidence); old.confidence = confidence(old._modelConfidence, [...new Set([...old.sources, ...item.sources].map((s) => s.publisher))].map((publisher) => ({ publisher }))); }
    if (map.size >= 25) break;
  }
  return { relations: [...map.values()].map(({ _modelConfidence, ...r }) => r), dropped };
}

export function validateAiIssues(parsed, stories, requested) {
  let dropped = 0;
  const byId = new Map(stories.map((s) => [s.id, s]));
  const requestedSet = new Set(requested);
  const map = new Map();
  for (const raw of Array.isArray(parsed?.issues) ? parsed.issues : []) {
    const cc = raw?.cc, cited = citedStories(raw.src, byId), summary = String(raw.s ?? '').trim();
    if (!requestedSet.has(cc) || !cited.some((s) => s.countries.includes(cc)) || summary.length < AI_LIMITS.issueMinChars || summary.length > AI_LIMITS.issueMaxChars || !isKorean(summary) || /https?:/i.test(summary)) { dropped++; continue; }
    const fields = [...new Set((Array.isArray(raw.d) ? raw.d : []).filter((f) => WORLD_FIELDS.includes(f)))];
    const item = { iso2: cc, summaryKo: summary, fields: fields.length ? fields : ['geopolitics'], sources: cited.map(sourceFor) };
    if (!map.has(cc)) map.set(cc, item);
    else map.get(cc).sources = mergeSources(map.get(cc).sources, item.sources);
  }
  return { issues: [...map.values()].slice(0, 20), dropped };
}

export function updateTrackedPairs(previous, relations, date) {
  const cutoff = addDays(date, -13);
  const next = Object.fromEntries(Object.entries(previous ?? {}).filter(([, day]) => day >= cutoff && day <= date));
  for (const r of relations) next[pairKey(r.from, r.to)] = date;
  return next;
}

export async function generateAiSnapshot({ pool, insights, date, nowMs, deadlineAtMs, callLlm, previous }) {
  const stories = selectAiInputStories(pool);
  if (!stories.length) throw Object.assign(new Error('story pool missing'), { nonRetryable: true });
  const calls = [], relations = [], issues = [];
  let provider = null, model = null, anyFailure = false;
  async function run(part, prompt, maxTokens, validate) {
    const budget = Math.min(AI_LIMITS.callBudgetMs, deadlineAtMs - nowMs() - 10_000);
    if (budget < AI_LIMITS.minCallMs) { anyFailure = true; calls.push({ part, ok: false, provider: null, kept: 0, dropped: 0 }); return null; }
    let accepted = null;
    const result = await callLlm(prompt, { maxTokens, callBudgetMs: budget, accept(text) { const check = validate(parseAiJson(text)); if (check.items.length) accepted = check; return check.items.length > 0; } });
    if (!result || !accepted) { anyFailure = true; calls.push({ part, ok: false, provider: null, kept: 0, dropped: 0 }); return null; }
    provider ??= result.provider; model ??= result.model;
    calls.push({ part, ok: true, provider: result.provider, kept: accepted.items.length, dropped: accepted.dropped });
    return accepted.items;
  }
  const relPrompt = buildRelationsPrompt(stories, date, insights?.worldBrief ?? null);
  relations.push(...(await run('relations', relPrompt, 1500, (v) => { const x = validateAiRelations(v, stories); return { items: x.relations, dropped: x.dropped }; }) ?? []));
  const countries = selectIssueCountries(stories);
  for (let i = 0; i < countries.length; i += AI_LIMITS.issueBatch) {
    const batch = countries.slice(i, i + AI_LIMITS.issueBatch);
    const p = buildIssuesPrompt(stories, batch, date);
    issues.push(...(await run('issues', p, 1400, (v) => { const x = validateAiIssues(v, stories, batch); return { items: x.issues, dropped: x.dropped }; }) ?? []));
  }
  if (!relations.length && !issues.length) throw Object.assign(new Error('no usable AI relations or issues'), { nonRetryable: true });
  const result = { date, generatedAt: nowMs(), status: anyFailure ? 'partial' : 'ok', provider, model, storyCount: stories.length, relations: relations.slice(0, 25), issues: issues.slice(0, 20), trackedPairs: updateTrackedPairs(previous?.trackedPairs, relations, date), diagnostics: { calls } };
  return result;
}

export function declareRecords(data) { return (data?.relations?.length ?? 0) + (data?.issues?.length ?? 0); }
