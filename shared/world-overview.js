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

const dateFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: WORLD_OVERVIEW_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit',
});
const hourFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: WORLD_OVERVIEW_TIMEZONE, hour: '2-digit', hourCycle: 'h23',
});

export function kstDate(nowMs) { return dateFormatter.format(new Date(nowMs)); }
export function kstHour(nowMs) { return Number(hourFormatter.format(new Date(nowMs))); }
export function addDays(date, days) {
  const [year, month, day] = String(date).split('-').map(Number);
  const result = new Date(Date.UTC(year, month - 1, day + Number(days)));
  return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`;
}
export function pairKey(a, b) { return [String(a), String(b)].sort().join(':'); }
