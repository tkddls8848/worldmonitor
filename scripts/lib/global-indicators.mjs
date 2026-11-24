import { pathToFileURL } from 'node:url';
import { getRedisCredentials, loadEnvFile, redisCommand, runSeed } from '../_seed-utils.mjs';

export const DAY_MS = 86_400_000;
export const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function shiftMonth(period, delta) {
  const date = new Date(period + '-01T00:00:00Z');
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
}

export function numeric(value) {
  if (typeof value === 'string' && value.trim()) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export async function fetchIndicator(url, headers = {}) {
  const response = await fetch(url, {
    headers: { 'User-Agent': 'WorldMonitor/1.0 (personal data collector)', ...headers },
    signal: AbortSignal.timeout(45_000),
  });
  if (!response.ok) throw new Error(`${new URL(url).hostname} returned HTTP ${response.status}`);
  return response;
}

export async function runIndicatorSeed(moduleUrl, name, cacheKey, fetchData, {
  recordCount, maxStaleMin = 4320, contentMeta, maxContentAgeMin,
}) {
  if (!process.argv[1] || pathToFileURL(process.argv[1]).href !== moduleUrl) return;
  loadEnvFile(moduleUrl);
  await runSeed('economic', name, cacheKey, fetchData, {
    // Keep the previous observation available after health starts reporting it stale.
    ttlSeconds: maxStaleMin * 60 * 2,
    maxStaleMin,
    sourceVersion: `${name}-v1`,
    validateFn: (value) => value != null && recordCount(value) > 0,
    recordCount,
    contentMeta,
    maxContentAgeMin,
    afterPublish: async () => {
      const { url, token } = getRedisCredentials();
      await redisCommand(url, token, ['SET', `seed-activated:economic:${name}`, '1', 'NX']);
    },
  });
}
