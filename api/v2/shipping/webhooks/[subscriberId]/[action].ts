/**
 * POST /api/v2/shipping/webhooks/{subscriberId}/rotate-secret
 * POST /api/v2/shipping/webhooks/{subscriberId}/reactivate
 *
 * Preserved on the legacy path-param URL shape because sebuf does not
 * currently support path-parameter RPC paths; tracked for eventual
 * migration under #3207.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from '../../../../_cors.js';
import { runRedisPipeline } from '../../../../../server/_shared/redis';
import { stripTrailingSlashes } from '../../../../../shared/strip-trailing-slashes.js';
import { PERSONAL_OWNER_ID } from '../../../../../shared/personal-owner.js';
import {
  ALL_INDEX_KEY,
  WEBHOOK_TTL,
  webhookKey,
  ownerIndexKey,
  generateSecret,
  type WebhookRecord,
} from '../../../../../server/worldmonitor/shipping/v2/webhook-shared';

export default async function handler(req: Request): Promise<Response> {
  const cors = getCorsHeaders(req, 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...cors, 'Content-Type': 'application/json', Allow: 'POST, OPTIONS' },
    });
  }

  const url = new URL(req.url);
  const parts = stripTrailingSlashes(url.pathname).split('/');
  const action = parts[parts.length - 1];
  const subscriberId = parts[parts.length - 2];

  if (!subscriberId || !subscriberId.startsWith('wh_')) {
    return new Response(JSON.stringify({ error: 'Webhook not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }
  if (action !== 'rotate-secret' && action !== 'reactivate') {
    return new Response(JSON.stringify({ error: 'Not found' }), {
      status: 404,
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  }

  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });

  // HTTP Basic auth on the personal server is the only access control; every
  // webhook belongs to the single owner.
  const ownerHash = PERSONAL_OWNER_ID;
  let newSecret: string | null = null;
  for (let attempt = 0; attempt < PERSIST_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, Math.min(500, 50 * 2 ** (attempt - 1)) * (0.5 + Math.random() * 0.5)));
    const read = await readRecord(subscriberId);
    if (read === 'unavailable') return json(503, { error: 'Service temporarily unavailable' });
    if (!read) return json(404, { error: 'Webhook not found' });
    const { raw, record } = read;

    if (record.ownerTag !== ownerHash) return json(403, { error: 'Forbidden' });

    let next: WebhookRecord;
    if (action === 'rotate-secret') {
      newSecret ??= await generateSecret();
      next = { ...record, secret: newSecret };
    } else {
      const { deactivatedAt: _deactivatedAt, ...revived } = record;
      next = { ...revived, active: true, failureCount: 0 };
    }

    const outcome = await persistWebhook(subscriberId, raw, next, record.ownerTag);
    if (outcome === 'conflict') continue;
    if (outcome !== 'stored') return json(503, { error: 'Service temporarily unavailable' });
    return action === 'rotate-secret'
      ? json(200, { subscriberId, secret: newSecret, rotatedAt: new Date().toISOString() })
      : json(200, { subscriberId, active: true });
  }
  return json(503, { error: 'Service temporarily unavailable' });
}

const PERSIST_ATTEMPTS = 3;

// The delivery worker rewrites the same record (failure counters, deactivation)
// with its own compare-and-set, so this write must not restore a snapshot read
// before the worker's: it applies only while the record is still `raw`, and the
// caller re-reads and retries otherwise. One script also keeps the record and
// both indexes from diverging, which the earlier MULTI/EXEC guaranteed.
const PERSIST_SCRIPT = [
  "if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])",
  "redis.call('SADD', KEYS[2], ARGV[4])",
  "redis.call('EXPIRE', KEYS[2], ARGV[3])",
  "redis.call('SADD', KEYS[4], ARGV[4])",
  "redis.call('EXPIRE', KEYS[4], ARGV[3])",
  "redis.call('SADD', KEYS[3], ARGV[4])",
  'return 1',
].join(' ');

async function readRecord(subscriberId: string): Promise<{ raw: string; record: WebhookRecord } | null | 'unavailable'> {
  const [row] = await runRedisPipeline([['GET', webhookKey(subscriberId)]]);
  if (!row || row.error) return 'unavailable';
  if (typeof row.result !== 'string') return null;
  try {
    return { raw: row.result, record: JSON.parse(row.result) as WebhookRecord };
  } catch {
    return null;
  }
}

async function persistWebhook(
  subscriberId: string,
  expectedRaw: string,
  record: WebhookRecord,
  ownerTag: string,
): Promise<'stored' | 'conflict' | 'unavailable'> {
  const [row] = await runRedisPipeline([[
    'EVAL', PERSIST_SCRIPT, '4',
    webhookKey(subscriberId), ownerIndexKey(ownerTag), ALL_INDEX_KEY,
    ownerIndexKey(record.quotaTag || ownerTag),
    expectedRaw, JSON.stringify(record), String(WEBHOOK_TTL), subscriberId,
  ]]);
  if (!row || row.error) return 'unavailable';
  if (row.result === 1 || row.result === '1') return 'stored';
  if (row.result === 0 || row.result === '0') return 'conflict';
  return 'unavailable';
}
