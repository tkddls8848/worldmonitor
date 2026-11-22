#!/usr/bin/env node
import { createRequire } from 'node:module';
import { runSeed, loadEnvFile, CHROME_UA } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);
const require = createRequire(import.meta.url);
const pointConfig = require('./shared/eu-gas-flow-points.json');
export const EU_GAS_FLOWS_KEY = 'energy:eu-gas-flows:v1';
export const EU_GAS_FLOWS_TTL_SECONDS = 64800;
const ORIGINS = ['russia', 'norway', 'northAfrica', 'lng'];
const BASE = 'https://transparency.entsog.eu/api/v1';

export function convertKwhDayToGwhDay(value) { return Number.isFinite(Number(value)) ? Number(value) / 1_000_000 : null; }
export function calculateChange7d(series) {
  const latest = series.at(-1)?.gwhPerDay;
  const prior = series.find((row) => row.date === shiftDate(series.at(-1)?.date, -7))?.gwhPerDay;
  return Number.isFinite(latest) && Number.isFinite(prior) && prior !== 0 ? ((latest - prior) / prior) * 100 : null;
}
function shiftDate(value, days) { const d = new Date(`${value}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }

function apiUrl(endpoint, params) {
  const url = new URL(`${BASE}/${endpoint}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url;
}
async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`ENTSOG HTTP ${response.status}`);
  return response.json();
}

export function selectPoints(metadata) {
  const eu = new Set(pointConfig.euCountries);
  const origins = Object.fromEntries(ORIGINS.map((key) => [key, new Set()]));
  for (const row of metadata) {
    const country = row.tSOCountry ?? row.country;
    const pointType = row.pointType ?? row.type;
    if (!eu.has(country) || row.directionKey !== 'entry' || row.isInvalid === true || row.hasData === false) continue;
    if (pointType === 'LNG Entry point') origins.lng.add(`${row.operatorKey}|${row.pointKey}`);
    for (const [origin, countries] of Object.entries(pointConfig.origins)) {
      if (countries.includes(row.adjacentCountry) && /Cross-Border Transmission IP/.test(pointType ?? '')) origins[origin].add(`${row.operatorKey}|${row.pointKey}`);
    }
  }
  return Object.fromEntries(ORIGINS.map((key) => [key, origins[key]]));
}

export function aggregateFlows(rows, points, today = new Date().toISOString().slice(0, 10)) {
  const dates = Array.from({ length: 14 }, (_, i) => shiftDate(today, i - 13));
  const totals = Object.fromEntries(ORIGINS.map((origin) => [origin, new Map(dates.map((date) => [date, 0]))]));
  const pointSets = selectPoints(points);
  for (const row of rows) {
    if (row.directionKey !== 'entry' || row.indicator !== 'Physical Flow') continue;
    const date = String(row.periodFrom ?? '').slice(0, 10);
    if (!dates.includes(date)) continue;
    const group = `${row.operatorKey}|${row.pointKey}`;
    if (row.value === null || row.value === undefined || row.value === '') continue;
    const gwh = convertKwhDayToGwhDay(Number(row.value));
    if (gwh === null) continue;
    for (const origin of ORIGINS) if (pointSets[origin].has(group)) totals[origin].set(date, totals[origin].get(date) + gwh);
  }
  return Object.fromEntries(ORIGINS.map((origin) => {
    if (pointSets[origin].size === 0) return [origin, null];
    const series = dates.map((date) => ({ date, gwhPerDay: totals[origin].get(date) }));
    return [origin, { gwhPerDay: series.at(-1).gwhPerDay, change7dPct: calculateChange7d(series), series }];
  }));
}

export async function fetchEuGasFlows() {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  // ENTSOG fills in a day's operator reports over the following day; yesterday is
  // routinely partial (Norway and LNG read ~35-45% low), so the latest settled day is D-2.
  const latestDate = shiftDate(today, -2);
  const from = shiftDate(latestDate, -13), to = today;
  const flows = await getJson(apiUrl('operationaldatas', { indicator: 'Physical Flow', periodType: 'day', from, to, limit: 20000 }));
  const records = flows.operationaldatas ?? [];
  if (Number(flows.meta?.total ?? 0) > records.length) throw new Error('ENTSOG flow response exceeded the configured limit');
  return { asOf: Date.now(), date: latestDate, origins: aggregateFlows(records, pointConfig.points, latestDate) };
}

if (process.argv[1]?.endsWith('seed-eu-gas-flows.mjs')) {
  await runSeed('energy', 'eu-gas-flows', EU_GAS_FLOWS_KEY, fetchEuGasFlows, {
    ttlSeconds: EU_GAS_FLOWS_TTL_SECONDS,
    recordCount: (data) => Object.values(data.origins).reduce((count, origin) => count + (origin?.series.length ?? 0), 0),
  });
}
