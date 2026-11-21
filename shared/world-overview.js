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
  return new Intl.DateTimeFormat('en-CA', { timeZone: WORLD_OVERVIEW_TIMEZONE }).format(new Date(nowMs));
}

export function kstHour(nowMs) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: WORLD_OVERVIEW_TIMEZONE, hour: '2-digit', hourCycle: 'h23' }).format(new Date(nowMs)));
}

export function addDays(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function pairKey(a, b) {
  return [a, b].sort().join(':');
}
