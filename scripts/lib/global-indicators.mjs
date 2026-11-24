import { pathToFileURL } from 'node:url';
import { loadEnvFile, runSeed } from '../_seed-utils.mjs';

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

export async function runIndicatorSeed(moduleUrl, name, fetchData, recordCount, maxStaleMin = 4320) {
  if (!process.argv[1] || pathToFileURL(process.argv[1]).href !== moduleUrl) return;
  loadEnvFile(moduleUrl);
  await runSeed('economic', name, `economic:${name}:v1`, fetchData, {
    ttlSeconds: maxStaleMin * 60,
    maxStaleMin,
    sourceVersion: `${name}-v1`,
    validateFn: (value) => value != null && recordCount(value) > 0,
    recordCount,
  });
}
