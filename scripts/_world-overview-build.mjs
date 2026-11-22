import { addDays, annotateWrongMarks, isDrawableEndpoint, kstDate, pairKey, relationMatchKey, WORLD_OVERVIEW_KEYS } from '../shared/world-overview.js';

export const LEVEL_THRESHOLDS = Object.freeze({ war: 1000, high: 100, medium: 25, tensionDeaths: 10, tensionCii: 50 });
export const UNREST_THRESHOLDS = Object.freeze({ ciiUnrest: 40, demonstrations: 300 });
export const NEWS_ISSUE = Object.freeze({ topStories: 50, minMentions: 2 });
export const LINE_CAPS = Object.freeze({ sanction: 200, tension: 100, tensionMinEventsPerDay: 10 });
export const ARCHIVE_DAYS = 90;
export const ARCHIVE_TTL_SECONDS = 7_862_400;
export const SNAPSHOT_MAX_BYTES = 262_144;
const LEVEL_RANK = Object.freeze({ null: 0, tension: 1, medium: 2, high: 3, war: 4 });

function moreSevereLevel(a, b) {
  return LEVEL_RANK[b ?? 'null'] > LEVEL_RANK[a ?? 'null'] ? b : a;
}

export function conflictLevel(deaths, ciiScore) {
  if (deaths !== null && deaths !== undefined) {
    if (deaths >= LEVEL_THRESHOLDS.war) return 'war';
    if (deaths >= LEVEL_THRESHOLDS.high) return 'high';
    if (deaths >= LEVEL_THRESHOLDS.medium) return 'medium';
    if (deaths >= LEVEL_THRESHOLDS.tensionDeaths) return 'tension';
  }
  return ciiScore >= LEVEL_THRESHOLDS.tensionCii ? 'tension' : null;
}

export function monthlyDeaths({ ucdp, hapi }) {
  const result = {};
  const hapiMonths = Object.values(hapi ?? {}).map((row) => typeof row.referencePeriod === 'string' ? row.referencePeriod.slice(0, 7) : null).filter(Boolean).sort();
  const month = ucdp?.referenceMonth ?? hapiMonths.at(-1) ?? null;
  if (ucdp?.referenceMonth === month && Array.isArray(ucdp.conflicts)) for (const row of ucdp.conflicts) {
    if (row.code && Number.isFinite(row.deaths)) result[row.code] = { count: row.deaths, source: 'ucdp', month: ucdp.referenceMonth };
  }
  for (const [code, row] of Object.entries(hapi ?? {})) {
    const rowMonth = typeof row.referencePeriod === 'string' ? row.referencePeriod.slice(0, 7) : null;
    if (!month || rowMonth !== month || !Number.isFinite(row.conflictFatalities)) continue;
    const prior = result[code];
    if (!prior || prior.month !== month || row.conflictFatalities > prior.count) result[code] = { count: row.conflictFatalities, source: 'hapi', month };
  }
  return result;
}

export function formatUsdKo(valueUsd) {
  const abs = Math.abs(valueUsd);
  const [divisor, suffix] = abs >= 1e12 ? [1e12, 'T'] : abs >= 1e9 ? [1e9, 'B'] : [1e6, 'M'];
  return `$${(valueUsd / divisor).toFixed(1)}${suffix}`;
}

function link(citations, key) { return citations?.[key] ? [citations[key]] : []; }
function trendFor(trends, from, to) { return from === 'EU' || from === 'UN' || to === 'EU' || to === 'UN' ? null : trends?.trends?.[pairKey(from, to)] ?? null; }
function fixedLine(id, kind, field, from, to, directed, value, label, sources, trends, basis) {
  return { id, origin: 'fixed', kind, ...(basis ? { basis } : {}), field, from, to, directed, score: 0, value, label, sources, trend: trendFor(trends, from, to) };
}

export function buildRelationLines({ relations, trends, ai, citations }) {
  const lines = [];
  for (const alliance of relations?.alliances?.bilateral ?? relations?.alliances ?? []) {
    const from = alliance.a, to = alliance.b;
    const [a, b] = [from, to].sort();
    const treatySource = alliance.source ? { ...alliance.source, publisher: alliance.source.publisher ?? alliance.source.title } : null;
    lines.push(fixedLine(`fixed:alliance:${a}-${b}`, 'alliance', 'diplomacy', a, b, false, Number(alliance.since) || 1, alliance.nameKo, treatySource ? [treatySource] : [], trends));
  }
  for (const pair of [...(relations?.sanctions?.pairs ?? [])].filter((p) => p.count >= 5).sort((a,b) => b.count-a.count).slice(0, LINE_CAPS.sanction)) {
    const source = (pair.source ?? relations?.sanctions?.source ?? '').includes('backup') ? (pair.issuer === 'UN' ? 'un' : pair.issuer === 'GB' ? 'uk' : 'opensanctions') : 'opensanctions';
    lines.push(fixedLine(`fixed:sanction:${pair.issuer}>${pair.target}`, 'sanction', 'finance', pair.issuer, pair.target, true, pair.count, `제재 대상 ${pair.count}건`, link(citations, source), trends));
  }
  for (const pair of relations?.economic?.trade ?? []) lines.push(fixedLine(`fixed:economic.trade:${pair.from}>${pair.to}`, 'economic', 'finance', pair.from, pair.to, true, pair.valueUsd, `전략 품목 수입 ${formatUsdKo(pair.valueUsd)}`, link(citations, 'comtrade'), trends, 'trade'));
  for (const pair of relations?.economic?.bankClaims ?? []) lines.push(fixedLine(`fixed:economic.bank:${pair.from}>${pair.to}`, 'economic', 'finance', pair.from, pair.to, true, pair.valueUsd, `은행 대외 채권 ${formatUsdKo(pair.valueUsd)}`, link(citations, 'bis'), trends, 'bank'));
  for (const [key, item] of Object.entries(trends?.trends ?? {}).filter(([,v]) => v.recentEventsPerDay >= LINE_CAPS.tensionMinEventsPerDay).sort((a,b) => b[1].recentIntensityPerDay-a[1].recentIntensityPerDay).slice(0, LINE_CAPS.tension)) {
    const [a,b] = key.split(':').sort();
    lines.push(fixedLine(`fixed:tension:${a}-${b}`, 'tension', 'geopolitics', a, b, false, item.recentIntensityPerDay, `충돌 사건 하루 ${Math.round(item.recentEventsPerDay)}건`, link(citations, 'gdelt'), trends));
  }
  for (const relation of ai?.relations ?? []) {
    const sourceLinks = relation.sources ?? [];
    const line = { id: `ai:${relation.kind}:${relation.from}>${relation.to}`, origin: 'ai', kind: relation.kind, field: relation.field ?? ({support:'military',sanction:'finance',alliance:'diplomacy',tension:'geopolitics'})[relation.kind], from: relation.from, to: relation.to, directed: ['support','sanction'].includes(relation.kind), score: 1 + relation.confidence, value: relation.confidence, label: relation.summaryKo, confidence: relation.confidence, sources: sourceLinks, trend: trendFor(trends, relation.from, relation.to) };
    if (relationMatchKey(line)) lines.push(line);
  }
  const maxValues = new Map();
  for (const line of lines.filter((line) => line.origin === 'fixed')) {
    const key = `${line.kind}:${line.basis ?? ''}`;
    maxValues.set(key, Math.max(maxValues.get(key) ?? 0, line.value));
  }
  for (const line of lines.filter((line) => line.origin === 'fixed')) line.score = maxValues.get(`${line.kind}:${line.basis ?? ''}`) ? line.value / maxValues.get(`${line.kind}:${line.basis ?? ''}`) : 0;
  return lines;
}

const inputStatus = (present, asOf, stale = false) => ({ status: !present ? 'missing' : stale ? 'stale' : 'ok', asOf: present ? asOf ?? null : null });
function storyCodes(pool) {
  const counts = new Map();
  for (const story of (pool?.stories ?? []).slice(0, NEWS_ISSUE.topStories)) for (const code of new Set(story.countryCodes ?? [])) counts.set(code, (counts.get(code) ?? 0) + 1);
  return new Set([...counts].filter(([, count]) => count >= NEWS_ISSUE.minMentions).map(([code]) => code));
}

export function nextAvailableDates(previous, date) {
  const cutoff = addDays(date, -(ARCHIVE_DAYS - 1));
  return [...new Set([...(previous ?? []), date].filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) && d >= cutoff && d <= date))].sort();
}

export function buildWorldOverviewSnapshot(inputs, opts) {
  const { relations, trends, ai, ucdpEvents, hapi = {}, cii, pool } = inputs;
  const { date, nowMs, marks, previousDates, config, conflictZoneLevels = {} } = opts;
  let ucdp = null;
  if (Array.isArray(ucdpEvents) && ucdpEvents.length) {
    try {
      // activeWarsReading is passed by the collector to keep the builder free of filesystem concerns.
      ucdp = opts.activeWarsReading(ucdpEvents, nowMs, { inPalestine: opts.inPalestine });
    } catch { ucdp = null; }
  }
  const deaths = monthlyDeaths({ ucdp, hapi });
  const ciiByCode = Object.fromEntries((cii?.scores ?? cii?.ciiScores ?? []).map((item) => [item.region, item]));
  const aiCurrent = ai?.date === date;
  const aiYesterday = ai?.date === addDays(date, -1);
  const aiStatus = aiCurrent ? 'ok' : aiYesterday ? 'stale' : 'missing';
  const codes = new Set([...Object.keys(deaths), ...Object.keys(ciiByCode), ...Object.keys(hapi)]);
  for (const bloc of relations?.alliances?.blocs ?? relations?.blocs ?? []) for (const code of bloc.members ?? []) codes.add(code);
  for (const issue of ai?.issues ?? []) codes.add(issue.iso2);
  for (const code of storyCodes(pool)) codes.add(code);
  const issueByCode = new Map((aiStatus !== 'missing' ? ai?.issues ?? [] : []).map((issue) => [issue.iso2, issue]));
  const inNews = storyCodes(pool);
  const countries = {};
  for (const code of Object.keys(conflictZoneLevels)) codes.add(code);
  for (const code of codes) {
    const ci = ciiByCode[code], h = hapi[code], d = deaths[code], issue = issueByCode.get(code);
    const level = moreSevereLevel(conflictLevel(d?.count ?? null, ci?.combinedScore ?? null), conflictZoneLevels[code]);
    countries[code] = { level, deaths: d ?? null,
      cii: ci ? { score: ci.combinedScore, unrest: ci.components?.ciiContribution ?? 0 } : null,
      demonstrations: Number.isFinite(h?.conflictDemonstrations) ? h.conflictDemonstrations : null,
      unrest: (ci?.components?.ciiContribution ?? 0) >= UNREST_THRESHOLDS.ciiUnrest || (h?.conflictDemonstrations ?? 0) >= UNREST_THRESHOLDS.demonstrations,
      blocs: (relations?.alliances?.blocs ?? relations?.blocs ?? []).filter((b) => b.members?.includes(code)).map((b) => b.id),
      inNews: inNews.has(code), issue: issue ? { summaryKo: issue.summaryKo, fields: issue.fields ?? [], sources: issue.sources ?? [] } : null };
  }
  const relationsOut = buildRelationLines({ relations, trends, ai: aiStatus === 'missing' ? null : ai, citations: config.citations });
  const snapshot = { schemaVersion: 1, date, generatedAt: nowMs, countries, relations: relationsOut,
    blocs: (relations?.alliances?.blocs ?? relations?.blocs ?? []).map((bloc) => ({ ...bloc, source: { ...bloc.source, publisher: bloc.source?.publisher ?? bloc.nameEn } })), anchors: config.anchors,
    ai: { status: aiStatus, date: ai?.date ?? null, model: ai?.model ?? null },
    inputs: { relations: inputStatus(!!relations, relations?.generatedAt), trends: inputStatus(!!trends, trends?.generatedAt), ai: inputStatus(aiStatus !== 'missing', ai?.generatedAt ?? nowMs, aiStatus === 'stale'),
      ucdp: inputStatus(!!ucdp, ucdp?.generatedAt), hapi: inputStatus(Object.keys(hapi).length > 0, nowMs), cii: inputStatus(!!cii, cii?.asOf), news: inputStatus(!!pool, pool?.generatedAt) },
    availableDates: nextAvailableDates(previousDates, date) };
  return annotateWrongMarks(snapshot, marks);
}

export function isValidSnapshot(data) {
  if (!data || typeof data !== 'object' || data.schemaVersion !== 1 || !/^\d{4}-\d{2}-\d{2}$/.test(data.date) || !Number.isFinite(data.generatedAt)) return false;
  if (!data.countries || !Array.isArray(data.relations) || !Array.isArray(data.blocs) || !data.inputs || !Array.isArray(data.availableDates)) return false;
  return Buffer.byteLength(JSON.stringify(data), 'utf8') <= SNAPSHOT_MAX_BYTES;
}
