export const WORLD_OVERVIEW_TIMEZONE = 'Asia/Seoul';

export const WORLD_OVERVIEW_KEYS = Object.freeze({
  relations: 'world-overview:relations:v1',
  pairTrends: 'gdelt:bulk:world-pair-trends:v1',
  ai: 'world-overview:ai:v1',
  snapshot: 'world-overview:snapshot:v1',
  archivePrefix: 'world-overview:snapshot:v1:',
  dates: 'world-overview:snapshot-dates:v1',
  marks: 'world-overview:wrong-marks:v1',
});

export function kstDate(nowMs) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: WORLD_OVERVIEW_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(nowMs);
}

export function kstHour(nowMs) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: WORLD_OVERVIEW_TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(nowMs));
}

export function addDays(date, days) {
  const [year, month, day] = date.split('-').map(Number);
  const value = new Date(Date.UTC(year, month - 1, day + days));
  return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
}

export function pairKey(a, b) { return [a, b].sort().join(':'); }

export const WORLD_FIELDS = Object.freeze(['military', 'diplomacy', 'geopolitics', 'politics', 'finance']);
export const DEFAULT_FIELDS = Object.freeze(['military', 'geopolitics']);
export const LINE_BUDGET = 30;
export const MARK_HIDE_DAYS = 14;
export const MARK_REAPPEAR_MIN_NEW_SOURCES = 2;
export const MARK_RETENTION_DAYS = 400;
export const AI_DISCLAIMER_KO = 'AI가 뉴스로 만든 요약이며 틀릴 수 있다';
export const FIELD_LABEL_KO = Object.freeze({ military: '군사', diplomacy: '외교', geopolitics: '지정학', politics: '정치', finance: '금융' });
export const KIND_LABEL_KO = Object.freeze({ support: '지원', sanction: '제재', alliance: '동맹', tension: '긴장', economic: '경제 의존' });
export const LEVEL_LABEL_KO = Object.freeze({ war: '전면전', high: '고강도', medium: '중강도', tension: '긴장·휴전', issue: '이슈 있음' });
export const TREND_LABEL_KO = Object.freeze({ collecting: '추세 집계 중', steady: '변화 없음', rising: '악화 중', easing: '완화 중', surging: '급등' });

export function isDrawableEndpoint(code, anchors) {
  if (Object.hasOwn(anchors ?? {}, code)) return true;
  if (code === 'UN' || code === 'EU') return false;
  return /^[A-Z]{2}$/.test(code);
}

function linePair(line) { return [line.from, line.to].sort().join('-'); }
function lineRank(a, b) {
  return (b.score ?? 0) - (a.score ?? 0)
    || (b.sources?.length ?? 0) - (a.sources?.length ?? 0)
    || (b.value ?? 0) - (a.value ?? 0)
    || a.id.localeCompare(b.id);
}

export function selectVisibleLines(snapshot, enabledFields, budget = LINE_BUDGET) {
  const eligible = snapshot.relations.filter((line) => enabledFields.includes(line.field)
    && line.mark?.state !== 'hidden'
    && isDrawableEndpoint(line.from, snapshot.anchors)
    && isDrawableEndpoint(line.to, snapshot.anchors));
  const byField = new Map();
  for (const field of WORLD_FIELDS) {
    const seen = new Set();
    const lines = eligible.filter((line) => line.field === field).sort(lineRank).filter((line) => {
      const key = `${line.kind}:${linePair(line)}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (lines.length) byField.set(field, lines);
  }
  const fields = WORLD_FIELDS.filter((field) => byField.has(field));
  if (!fields.length || budget <= 0) return [];
  const base = Math.floor(budget / fields.length);
  let remainder = budget % fields.length;
  const picked = new Map(fields.map((field) => {
    const share = base + (remainder-- > 0 ? 1 : 0);
    return [field, byField.get(field).slice(0, share)];
  }));
  let used = [...picked.values()].reduce((n, lines) => n + lines.length, 0);
  while (used < budget) {
    let progressed = false;
    for (const field of fields) {
      const lines = byField.get(field), take = picked.get(field);
      if (take.length < lines.length && used < budget) { take.push(lines[take.length]); used++; progressed = true; }
    }
    if (!progressed) break;
  }
  return WORLD_FIELDS.flatMap((field) => picked.get(field) ?? []);
}

export function countryFill(country) {
  if (country.level) return country.level;
  if (country.issue) return country.issue.mark?.state === 'hidden' ? null : 'issue';
  return country.inNews ? 'issue' : null;
}

function relationMatchKey(line) { return `${line.kind}:${linePair(line)}`; }

export function annotateWrongMarks(snapshot, doc) {
  const marks = (doc?.marks ?? []).filter((mark) => !mark.undoneAt);
  const relations = snapshot.relations.map(({ mark: _mark, ...line }) => {
    if (line.origin !== 'ai') return line;
    const match = marks.find((item) => item.type === 'relation' && item.matchKey === relationMatchKey(line)
      && item.date <= snapshot.date && snapshot.date <= addDays(item.date, MARK_HIDE_DAYS - 1));
    if (!match) return line;
    const known = new Set(match.sourceUrls ?? []);
    const fresh = line.sources.filter((source) => !known.has(source.url)).length;
    return { ...line, mark: { state: fresh >= MARK_REAPPEAR_MIN_NEW_SOURCES ? 'reappeared' : 'hidden', markId: match.id, markedAt: match.markedAt } };
  });
  const countries = Object.fromEntries(Object.entries(snapshot.countries).map(([iso2, country]) => {
    const { mark: _mark, ...issue } = country.issue ?? {};
    const item = marks.find((mark) => mark.type === 'issue' && mark.iso2 === iso2 && mark.date === snapshot.date);
    return [iso2, { ...country, issue: country.issue ? (item ? { ...issue, mark: { state: 'hidden', markId: item.id, markedAt: item.markedAt } } : issue) : null }];
  }));
  return { ...snapshot, relations, countries };
}

export function applyMarkAction(doc, action, snapshot, nowMs) {
  const marks = [...(doc?.marks ?? [])];
  if (action.action === 'unmark') {
    const index = marks.findIndex((mark) => mark.id === action.markId && !mark.undoneAt);
    if (index < 0) return { ok: false, error: 'MARK_NOT_FOUND' };
    marks[index] = { ...marks[index], undoneAt: nowMs };
    return { ok: true, doc: { marks, updatedAt: nowMs }, mark: marks[index] };
  }
  if (!snapshot || snapshot.date !== action.date) return { ok: false, error: 'TARGET_NOT_FOUND' };
  let mark;
  if (action.target.type === 'relation') {
    const line = snapshot.relations.find((item) => item.id === action.target.relationId);
    if (!line) return { ok: false, error: 'TARGET_NOT_FOUND' };
    if (line.origin !== 'ai') return { ok: false, error: 'NOT_MARKABLE' };
    const matchKey = relationMatchKey(line), id = `rel:${action.date}:${matchKey}`;
    mark = { id, type: 'relation', date: action.date, matchKey, sourceUrls: line.sources.map((source) => source.url), summaryKo: line.label, markedAt: nowMs };
  } else {
    const issue = snapshot.countries[action.target.iso2]?.issue;
    if (!issue) return { ok: false, error: 'TARGET_NOT_FOUND' };
    mark = { id: `issue:${action.date}:${action.target.iso2}`, type: 'issue', date: action.date, iso2: action.target.iso2, sourceUrls: issue.sources.map((source) => source.url), summaryKo: issue.summaryKo, markedAt: nowMs };
  }
  const previous = marks.findIndex((item) => item.id === mark.id);
  if (previous >= 0) marks.splice(previous, 1);
  marks.push(mark);
  const cutoff = nowMs - MARK_RETENTION_DAYS * 86_400_000;
  const retained = marks.filter((item) => item.markedAt >= cutoff);
  return { ok: true, doc: { marks: retained, updatedAt: nowMs }, mark };
}
