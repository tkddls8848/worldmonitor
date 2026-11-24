import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';
import { warmPersonalDigest } from './seed-news-digest.mjs';
import { threatSummaryCountries } from './lib/news-threat-countries.cjs';

const KEY = 'news:threat:summary:v1';
const TTL_SECONDS = 7200;
const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
const LEVELS = ['critical', 'high', 'medium', 'low', 'info'];
const PROTO_LEVELS = new Map(LEVELS.map((level) => [`THREAT_LEVEL_${level.toUpperCase()}`, level]));

function hasCurrentDigest(digest) {
  return ['complete', 'partial'].includes(digest?.coverage?.state)
    && !digest.coverage.servedStale
    && digest.categories && typeof digest.categories === 'object';
}

export function summarizeNewsThreat(digests, now = Date.now()) {
  // The full English cell is the primary input. Specialty editions supplement it.
  if (!hasCurrentDigest(digests[0])) throw new Error('Current full English news digest unavailable');
  const byCountry = {};
  const seen = new Set();
  for (const digest of digests.filter(hasCurrentDigest)) {
    for (const bucket of Object.values(digest.categories)) {
      for (const item of Array.isArray(bucket?.items) ? bucket.items : []) {
        const title = typeof item?.title === 'string' ? item.title.trim() : '';
        const level = PROTO_LEVELS.get(item?.threat?.level);
        if (!title || !level || !Number.isFinite(item.publishedAt)
          || item.publishedAt < now - SIX_HOURS_MS || item.publishedAt > now) continue;
        const key = title.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        for (const code of threatSummaryCountries(title)) {
          byCountry[code] ??= { critical: 0, high: 0, medium: 0, low: 0, info: 0 };
          byCountry[code][level]++;
        }
      }
    }
  }
  if (Object.keys(byCountry).length === 0 && digests.some((digest) => !hasCurrentDigest(digest) || digest.coverage.state !== 'complete')) {
    throw new Error('Incomplete digest coverage cannot confirm a quiet news cycle');
  }
  return { byCountry, generatedAt: now };
}

export async function fetchNewsThreatSummary(options) {
  const { digests } = await warmPersonalDigest(options);
  return summarizeNewsThreat(digests);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  loadEnvFile(import.meta.url);
  await runSeed('news', 'threat-summary', KEY, () => fetchNewsThreatSummary(), {
    ttlSeconds: TTL_SECONDS,
    extendTtlOnFailure: false,
    declareRecords: (data) => Object.keys(data.byCountry).length,
    schemaVersion: 1,
    sourceVersion: 'news-threat-summary-digest',
    zeroIsValid: true,
  });
}
