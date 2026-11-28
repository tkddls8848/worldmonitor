#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { callLlmViaInsights } from './_world-relations-ai.mjs';
import {
  getRedisCredentials, loadEnvFile, readCanonicalValue, redisCommand, runSeed,
} from './_seed-utils.mjs';
import { PERSONAL_DIGEST_CELLS } from './seed-news-digest.mjs';
import { markActivated } from './_world-overview-io.mjs';
import { IMPACT_DAY_MS as DAY } from '../shared/impact-links.ts';
import {
  NEWS_EVENTS_KEY, NEWS_EVENT_BATCH_SIZE, NEWS_EVENT_DAY_CAP, NEWS_EVENT_INTERVAL_SECONDS,
  NEWS_EVENT_RUN_CAP, NEWS_EVENT_TTL_SECONDS, digestEventItems, extractNewsEventBatch, prioritizeEventItems,
} from './_news-events.mjs';

const CELLS = [...PERSONAL_DIGEST_CELLS, { edition: 'full', lang: 'ko' }];
const PREFIX = 'news:impact-events:budget:v1';

// Same exact-URL revocation set used by the digest's server readers.
export async function readNewsEventRevocations() {
  const { url, token } = getRedisCredentials();
  const { result: revoked } = await redisCommand(url, token, ['SMEMBERS', 'news:digest:revoked-urls:v1']);
  if (!Array.isArray(revoked)) throw new Error('Unable to read digest URL revocations');
  return new Set(revoked);
}

export function createNewsEventBudget(command, clock = Date.now) {
  const stats = { calls: 0, promptTokens: 0, completionTokens: 0, rateLimited: 0, models: {} };
  const throttled = new Set();
  let quotaHit = false;
  let dayKey;
  return {
    stats,
    get quotaHit() { return quotaHit; },
    async start() {
      return await command(['SET', `${PREFIX}:interval`, '1', 'NX', 'EX', NEWS_EVENT_INTERVAL_SECONDS]) === 'OK';
    },
    async reserveAttempt(model) {
      if (stats.calls >= NEWS_EVENT_RUN_CAP) return false;
      const now = clock();
      const key = `${PREFIX}:day:${Math.floor(now / DAY)}`;
      if (key !== dayKey) {
        await command(['SET', key, '0', 'NX', 'EX', 2 * 86_400]);
        dayKey = key;
      }
      if (Number(await command(['GET', key])) >= NEWS_EVENT_DAY_CAP
        || Number(await command(['INCR', key])) > NEWS_EVENT_DAY_CAP) {
        quotaHit = true;
        return false;
      }
      stats.calls++;
      stats.models[model] = (stats.models[model] ?? 0) + 1;
      return true;
    },
    skipModel: (model) => throttled.has(model),
    onAttemptResult({ model, status, promptTokens, completionTokens }) {
      if (status === 429) {
        stats.rateLimited++;
        throttled.add(model);
      }
      if (Number.isSafeInteger(promptTokens) && promptTokens >= 0) stats.promptTokens += promptTokens;
      if (Number.isSafeInteger(completionTokens) && completionTokens >= 0) stats.completionTokens += completionTokens;
    },
  };
}

export async function collectNewsEvents({ digests, previous, revoked, now, budget, configured, callLlm = callLlmViaInsights }) {
  const processed = Object.fromEntries(Object.entries(previous?.processed ?? {}).filter(([, until]) => until > now));
  const events = (previous?.events ?? []).filter(({ item }) => item.publishedAt >= now - 7 * DAY && !revoked.has(item.url));
  const items = digestEventItems(digests, { now, processed, revoked });
  const candidates = configured ? prioritizeEventItems(items) : [];
  let status = !configured ? 'not-configured'
    : digests.some((d) => ['complete', 'partial'].includes(d?.coverage?.state) && !d.coverage.servedStale) ? 'ok' : 'digest-unavailable';
  let processedCount = 0;
  let lastSuccessAt = previous?.lastSuccessAt ?? 0;
  for (let offset = 0; offset < candidates.length && budget.stats.calls < NEWS_EVENT_RUN_CAP; offset += NEWS_EVENT_BATCH_SIZE) {
    const batch = candidates.slice(offset, offset + NEWS_EVENT_BATCH_SIZE);
    const result = await extractNewsEventBatch(batch, { callLlm, ...budget });
    if (!result) {
      status = budget.quotaHit ? 'daily-cap' : budget.stats.rateLimited ? 'rate-limited' : 'provider-unavailable';
      break;
    }
    for (const { id, titleId } of batch) {
      processed[id] = processed[titleId] = now + NEWS_EVENT_TTL_SECONDS * 1000;
    }
    events.push(...result.events);
    processedCount += batch.length;
    lastSuccessAt = now;
  }
  return {
    events, processed, status, lastSuccessAt, generatedAt: now,
    stats: { ...budget.stats, newItems: items.length, candidates: candidates.length, processed: processedCount },
  };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  loadEnvFile(import.meta.url);
  const { url, token } = getRedisCredentials();
  const budget = createNewsEventBudget(async (command) => (await redisCommand(url, token, command)).result);
  if (await budget.start()) {
    await runSeed('news', 'impact-events', NEWS_EVENTS_KEY, async () => {
      const [previous, revocations, ...digests] = await Promise.all([
        readCanonicalValue(NEWS_EVENTS_KEY, { strict: true }),
        readNewsEventRevocations(),
        ...CELLS.map(({ edition, lang }) => readCanonicalValue(`news:digest:v1:${edition}:${lang}`)),
      ]);
      const data = await collectNewsEvents({
        digests, previous, revoked: revocations, now: Date.now(), budget, configured: Boolean(process.env.OPENROUTER_API_KEY),
      });
      console.log(`[news-events] ${data.status} ${JSON.stringify(data.stats)} costUsd=0`);
      return data;
    }, {
      ttlSeconds: NEWS_EVENT_TTL_SECONDS, maxStaleMin: 90, sourceVersion: 'digest-impact-events-v1', schemaVersion: 1,
      declareRecords: (data) => data.events.length, zeroIsValid: true, extendTtlOnFailure: false,
      lockTtlMs: 270_000, fetchPhaseTimeoutMs: 240_000,
      afterPublish: (data) => ({
        freshnessMetaPatch: {
          sourceState: data.status === 'not-configured' ? 'unavailable' : data.status === 'ok' ? 'ok' : 'degraded',
          errorCode: data.status === 'ok' ? undefined : data.status.toUpperCase().replaceAll('-', '_'),
        },
      }),
      afterFreshness: () => markActivated('seed-activated:news:impact-events'),
    });
  } else console.log('[news-events] skipped within the 30-minute interval');
}
