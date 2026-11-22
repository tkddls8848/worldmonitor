import { loadEnvFile, CHROME_UA, runSeed } from './_seed-utils.mjs';
import { resolveIso2 } from './_country-resolver.mjs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const API = 'https://api.ioda.inetintel.cc.gatech.edu/v2/outages/events';
const KEY = 'infra:ioda-outages:v1';
const TTL_SECONDS = 5400; // 90 minutes: 3x the 30 minute collection interval.

// IODA event scores are multiplicative evidence scores. These bands are a
// local display convention: >=100,000 high, >=1,000 medium, otherwise low.
export function severityForScore(score) {
  if (!Number.isFinite(score)) return 'low';
  if (score >= 100_000) return 'high';
  if (score >= 1_000) return 'medium';
  return 'low';
}

export function mapIodaEvents(rows, windowFrom, windowUntil) {
  const mapped = [];
  for (const row of rows) {
    if (!row) continue;
    const location = String(row.location ?? '');
    const entityType = row.entityType ?? location.split('/')[0];
    const entityCode = row.entityCode ?? location.split('/')[1];
    if (entityType !== 'country') continue;
    const code = String(entityCode ?? '');
    const iso2 = resolveIso2({ iso2: code, iso3: code, name: code });
    const startSec = Number(row.from ?? row.start);
    if (!iso2 || !Number.isFinite(startSec)) continue;
    const endSec = Number.isFinite(Number(row.until)) ? Number(row.until) : Number(row.duration) > 0 ? startSec + Number(row.duration) : NaN;
    const score = row.score == null || row.score === '' ? null : Number.isFinite(Number(row.score)) ? Number(row.score) : null;
    const signal = String(row.datasource ?? '').trim();
    const start = startSec * 1000;
    const end = Number.isFinite(endSec) && endSec > startSec ? endSec * 1000 : null;
    mapped.push({
      id: `ioda-${iso2.toLowerCase()}-${signal || 'event'}-${startSec}`,
      iso2,
      countryName: String(row.location_name ?? row.entityName ?? iso2),
      start,
      end,
      severity: severityForScore(score),
      signals: signal ? [signal] : [],
      score,
      url: `https://ioda.inetintel.cc.gatech.edu/country/${encodeURIComponent(iso2)}?from=${Math.floor(windowFrom / 1000)}&until=${Math.floor(windowUntil / 1000)}`,
    });
  }
  const deduped = new Map();
  for (const item of mapped) {
    const prior = deduped.get(item.id);
    if (prior) {
      prior.signals = [...new Set([...prior.signals, ...item.signals])].sort();
      if (item.score !== null && (prior.score === null || item.score > prior.score)) {
        prior.score = item.score;
        prior.severity = severityForScore(item.score);
      }
      if (item.end !== null && (prior.end === null || item.end > prior.end)) prior.end = item.end;
    } else deduped.set(item.id, item);
  }
  return [...deduped.values()].sort((a, b) => b.start - a.start || a.id.localeCompare(b.id)).slice(0, 100);
}

export async function fetchIodaOutages({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const until = Math.floor(nowMs / 1000);
  const from = until - 48 * 60 * 60;
  const url = new URL(API);
  url.search = new URLSearchParams({ from: String(from), until: String(until), entityType: 'country', format: 'codf', limit: '1000', orderBy: 'time/desc' }).toString();
  const response = await fetchImpl(url, { headers: { Accept: 'application/json', 'User-Agent': CHROME_UA }, signal: AbortSignal.timeout(45_000) });
  if (!response.ok) throw new Error(`IODA events HTTP ${response.status}`);
  const body = await response.json();
  const rows = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(rows)) throw new Error('IODA events response did not contain an array');
  return { asOf: nowMs, outages: mapIodaEvents(rows, from * 1000, until * 1000) };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  loadEnvFile(import.meta.url);
  await runSeed('infra', 'ioda-outages', KEY, fetchIodaOutages, {
    ttlSeconds: TTL_SECONDS,
    validateFn: (value) => value && Number.isFinite(value.asOf) && Array.isArray(value.outages),
    recordCount: (value) => value.outages.length,
    sourceVersion: 'ioda-events-48h',
    maxStaleMin: 120,
  });
}
