#!/usr/bin/env node
import config from '../shared/world-overview-config.json' with { type: 'json' };
import iso2ToIso3 from '../shared/iso2-to-iso3.json' with { type: 'json' };
import { WORLD_OVERVIEW_KEYS, kstDate } from '../shared/world-overview.js';
import { activeWarsReading, palestineLocator } from './active-wars.mjs';
import { CII_RISK_SCORE_CACHE_KEYS } from './_cii-risk-cache-keys.mjs';
import { redisPipeline } from '../api/_upstash-json.js';
import { unwrapEnvelope } from './_seed-envelope-source.mjs';
import { loadEnvFile, readCanonicalValue, runSeed, writeExtraKey } from './_seed-utils.mjs';
import { wmApiBase, wmApiFetch } from './lib/personal-api.mjs';
import { fileURLToPath } from 'node:url';
import { markActivated } from './_world-overview-io.mjs';
import { ARCHIVE_TTL_SECONDS, buildWorldOverviewSnapshot, isValidSnapshot } from './_world-overview-build.mjs';

const HAPI_PREFIX = 'conflict:humanitarian:v1:';
const USER_AGENT = 'WorldMonitor-Personal-Collect/1.0 (world-overview)';
// Bootstrap key world-overview:snapshot:v1 is a first-screen, on-demand read.
export function declareRecords(data) { return Object.keys(data?.countries ?? {}).length + (data?.relations?.length ?? 0); }

async function fetchCii() {
  const fetcher = wmApiFetch();
  const response = await fetcher(`${wmApiBase()}/api/intelligence/v1/get-risk-scores`, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`CII API HTTP ${response.status}`);
  return response.json();
}

export async function readBuildInputs({ readValue = readCanonicalValue, readHapi = defaultReadHapi, fetchCii: fetch = () => fetchCii(), nowMs = Date.now() } = {}) {
  const [relations, trends, ai, ucdpRaw, pool, ciiRaw] = await Promise.all([
    readValue(WORLD_OVERVIEW_KEYS.relations).catch(() => null), readValue(WORLD_OVERVIEW_KEYS.pairTrends).catch(() => null),
    readValue(WORLD_OVERVIEW_KEYS.ai).catch(() => null), readValue('conflict:ucdp-events:v1').catch(() => null),
    readValue('news:insights:v1:pool').catch(() => null), readValue(CII_RISK_SCORE_CACHE_KEYS.stale).catch(() => null),
  ]);
  const hapi = await readHapi();
  let cii = ciiRaw?.scores || ciiRaw?.ciiScores ? ciiRaw : null;
  if (!cii) {
    try { const response = await fetch(); cii = Array.isArray(response?.ciiScores) ? { scores: response.ciiScores, asOf: nowMs } : null; } catch { cii = null; }
  }
  return { relations, trends, ai, ucdpEvents: Array.isArray(ucdpRaw) ? ucdpRaw : Array.isArray(ucdpRaw?.events) ? ucdpRaw.events : null, hapi, cii, pool };
}

async function defaultReadHapi() {
  const codes = Object.keys(iso2ToIso3).filter((code) => /^[A-Z]{2}$/.test(code));
  const result = await redisPipeline(codes.map((code) => ['GET', `${HAPI_PREFIX}${code}`]), 15_000, false);
  if (!result || result.length !== codes.length) return {};
  const out = {};
  result.forEach((entry, index) => {
    try {
      if (entry?.result == null || entry?.error) return;
      const { data } = unwrapEnvelope(entry.result);
      const summary = data?.previousCompleteSummary ?? data?.summary;
      if (summary) out[codes[index]] = summary;
    } catch { /* malformed country records degrade independently */ }
  });
  return out;
}

const direct = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
if (direct) {
  loadEnvFile(import.meta.url);
  const nowMs = Date.now(), date = kstDate(nowMs);
  const deps = await readBuildInputs({ nowMs });
  const previousDates = await readCanonicalValue(WORLD_OVERVIEW_KEYS.dates).catch(() => null);
  const marks = await readCanonicalValue(WORLD_OVERVIEW_KEYS.marks).catch(() => null);
  const locator = palestineLocator(fileURLToPath(new URL('..', import.meta.url)));
  await runSeed('world-overview', 'snapshot', WORLD_OVERVIEW_KEYS.snapshot,
    async () => buildWorldOverviewSnapshot(deps, { date, nowMs, marks, previousDates, config, activeWarsReading, inPalestine: (lat, lon) => locator(lat, lon) }),
    { validateFn: isValidSnapshot, declareRecords, ttlSeconds: 172800, sourceVersion: 'world-overview-v1', schemaVersion: 1, maxStaleMin: 360,
      afterPublish: async (data) => {
        await writeExtraKey(`${WORLD_OVERVIEW_KEYS.archivePrefix}${date}`, data, ARCHIVE_TTL_SECONDS);
        await writeExtraKey(WORLD_OVERVIEW_KEYS.dates, data.availableDates, ARCHIVE_TTL_SECONDS);
        await markActivated('seed-activated:world-overview:snapshot');
      } });
}
