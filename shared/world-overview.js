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
  return Number(new Intl.DateTimeFormat('en-US', { timeZone: WORLD_OVERVIEW_TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(nowMs));
}

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function pairKey(a, b) { return [a, b].sort().join(':'); }

export const WORLD_FIELDS = Object.freeze(['military', 'diplomacy', 'geopolitics', 'politics', 'finance']);
export const AI_RELATION_KINDS = Object.freeze(['support', 'sanction', 'alliance', 'tension']);
export const DIRECTED_KINDS = new Set(['support', 'sanction', 'economic']);
export const KIND_DEFAULT_FIELD = Object.freeze({ support: 'military', sanction: 'finance', alliance: 'diplomacy', tension: 'geopolitics' });
export function relationMatchKey(r) {
  const pair = DIRECTED_KINDS.has(r.kind) ? `${r.from}>${r.to}` : [r.from, r.to].sort().join('-');
  return `${r.kind}:${pair}`;
}
