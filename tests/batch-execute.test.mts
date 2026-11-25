/**
 * Unit + gateway tests for the generic REST batch endpoint
 * (POST /api/batch/v1/execute, server/worldmonitor/batch/v1/execute-batch.ts).
 *
 * The handler re-dispatches each operation as a same-origin GET through the
 * public gateway, so the security posture rests on five invariants pinned
 * here:
 *   1. only same-origin, documented-RPC-shaped paths are fetched (SSRF guard);
 *   2. credentials and negotiation headers cross; cookies and trusted
 *      principal stamps do not;
 *   3. a batch can never recurse (marker header + /api/batch/* path both
 *      refuse).
 * Personal fork: sub-requests carry no rate-limit admission and nothing is pre-charged.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createExecuteBatch,
  BATCH_MARKER_HEADER,
  LOCAL_API_TOKEN_HEADER,
  MAX_BATCH_OPERATIONS,
  MAX_SUB_RESPONSE_BYTES,
} from '../server/worldmonitor/batch/v1/execute-batch.ts';
import type { FetchLike } from '../server/worldmonitor/batch/v1/execute-batch.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';

const ORIGIN = 'https://www.worldmonitor.app';
const CALLER_IP = '203.0.113.9';

function makeCtx(headers: Record<string, string> = {}) {
  const request = new Request(`${ORIGIN}/api/batch/v1/execute`, {
    method: 'POST',
    headers: { 'x-real-ip': CALLER_IP, ...headers },
  });
  return { request, pathParams: {}, headers: Object.fromEntries(request.headers.entries()) };
}

type RecordedCall = { url: string; init: RequestInit };

function recordingFetch(
  respond: (url: string) => Response | Promise<Response> = () =>
    new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }),
): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init: init ?? {} });
    return respond(url);
  };
  return { calls, fetchImpl };
}

describe('executeBatch handler', () => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    installRedis({});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  it('fans out operations as same-origin GETs and aggregates results in order', async () => {
    const { calls, fetchImpl } = recordingFetch((url) =>
      url.includes('get-fear-greed-index')
        ? new Response(JSON.stringify({ compositeScore: 42 }), { status: 200 })
        : new Response(JSON.stringify({ message: 'not found' }), { status: 404 }),
    );
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'fg', path: '/api/market/v1/get-fear-greed-index' },
        { id: '', path: '/api/market/v1/list-market-quotes' },
      ],
    });

    assert.equal(calls.length, 2);
    // Admission is asynchronous; dispatch order is not the result-order contract.
    assert.deepEqual(calls.map(({ url }) => url).sort(), [
      `${ORIGIN}/api/market/v1/get-fear-greed-index`,
      `${ORIGIN}/api/market/v1/list-market-quotes`,
    ].sort());
    assert.ok(calls.every(({ init }) => init.method === 'GET'));
    assert.deepEqual(res.results[0], { id: 'fg', status: 200, body: { compositeScore: 42 }, error: '' });
    // Blank id defaults to the zero-based index.
    assert.equal(res.results[1]!.id, '1');
    assert.equal(res.results[1]!.status, 404);
    assert.equal(res.succeeded, 1);
    assert.equal(res.failed, 1);
  });

  it('preserves query strings (filters + jmespath projections) on sub-requests', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(makeCtx(), {
      operations: [{ id: 'r', path: '/api/intelligence/v1/get-country-risk?country=DE&jmespath=score' }],
    });

    assert.equal(calls[0]!.url, `${ORIGIN}/api/intelligence/v1/get-country-risk?country=DE&jmespath=score`);
  });

  it('forwards only credential/negotiation headers and stamps the batch marker', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(
      makeCtx({
        Authorization: 'Bearer wm_deadbeef',
        'X-WorldMonitor-Key': 'wm_cafebabe',
        Cookie: 'session=secret',
        'x-user-id': 'user_123',
        'User-Agent': 'my-agent/2.0',
      }),
      { operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] },
    );

    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.equal(sent.get('authorization'), 'Bearer wm_deadbeef');
    assert.equal(sent.get('x-worldmonitor-key'), 'wm_cafebabe');
    assert.equal(sent.get(BATCH_MARKER_HEADER), '1');
    assert.equal(sent.get('accept'), 'application/json');
    assert.equal(sent.get('user-agent'), 'my-agent/2.0');
    // Cookies and the legacy user-id trust marker must never cross into
    // sub-requests.
    assert.equal(sent.get('cookie'), null);
    assert.equal(sent.get('x-user-id'), null);
    // Personal fork: no rate-limit admission crosses with the sub-request.
    assert.equal(sent.get('x-wm-sub-request'), null);
  });

  it('authenticates sub-requests to the local API with the server\'s own token, never the caller\'s', async () => {
    const op = { operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] };
    const local = (headers: Record<string, string> = {}) => {
      const request = new Request('http://127.0.0.1:41234/api/batch/v1/execute', { method: 'POST', headers });
      return { request, pathParams: {}, headers: Object.fromEntries(request.headers.entries()) };
    };

    const { calls, fetchImpl } = recordingFetch();
    await createExecuteBatch(fetchImpl, () => 'server-token')(local({ [LOCAL_API_TOKEN_HEADER]: 'caller-token' }), op);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:41234/api/market/v1/get-fear-greed-index');
    assert.equal(new Headers(calls[0]!.init.headers as HeadersInit).get(LOCAL_API_TOKEN_HEADER), 'server-token');

    // No server token: nothing is sent, and the caller's value is not relayed.
    const unset = recordingFetch();
    await createExecuteBatch(unset.fetchImpl, () => undefined)(local({ [LOCAL_API_TOKEN_HEADER]: 'caller-token' }), op);
    assert.equal(new Headers(unset.calls[0]!.init.headers as HeadersInit).get(LOCAL_API_TOKEN_HEADER), null);

    // A public origin never receives the local credential.
    const publicOrigin = recordingFetch();
    await createExecuteBatch(publicOrigin.fetchImpl, () => 'server-token')(makeCtx(), op);
    assert.equal(new Headers(publicOrigin.calls[0]!.init.headers as HeadersInit).get(LOCAL_API_TOKEN_HEADER), null);
  });

  it('sends a descriptive default User-Agent when the caller omits one (CF WAF rejects generic UAs)', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    await executeBatch(makeCtx(), { operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }] });

    const sent = new Headers(calls[0]!.init.headers as HeadersInit);
    assert.match(sent.get('user-agent') ?? '', /WorldMonitor-Batch/);
  });

  it('rejects non-RPC and cross-origin paths per-operation without fetching', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'abs', path: 'https://evil.com/api/market/v1/get-fear-greed-index' },
        { id: 'scheme-rel', path: '//evil.com/api/market/v1/get-fear-greed-index' },
        { id: 'no-slash', path: 'api/market/v1/get-fear-greed-index' },
        { id: 'not-rpc', path: '/api/mcp' },
        { id: 'upper', path: '/API/market/v1/get-fear-greed-index' },
        { id: 'ok', path: '/api/v2/shipping/route-intelligence' },
      ],
    });

    // Only the valid v2 path reached fetch.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, `${ORIGIN}/api/v2/shipping/route-intelligence`);
    for (const bad of res.results.slice(0, 5)) {
      assert.equal(bad.status, 0);
      assert.equal(bad.error, 'invalid_path');
    }
    assert.equal(res.failed, 5);
  });

  it('refuses nested batches: batched /api/batch/* paths and marked inbound requests', async () => {
    const { calls, fetchImpl } = recordingFetch();
    const executeBatch = createExecuteBatch(fetchImpl);

    const res = await executeBatch(makeCtx(), {
      operations: [{ id: 'n', path: '/api/batch/v1/execute' }],
    });
    assert.equal(calls.length, 0);
    assert.deepEqual(res.results[0], { id: 'n', status: 0, error: 'nested_batch' });

    await assert.rejects(
      executeBatch(makeCtx({ [BATCH_MARKER_HEADER]: '1' }), {
        operations: [{ id: 'a', path: '/api/market/v1/get-fear-greed-index' }],
      }),
      (err: Error & { statusCode?: number }) => err.name === 'ApiError' && err.statusCode === 400,
    );
  });

  it('rejects empty, oversized, and duplicate-id batches with a ValidationError', async () => {
    const executeBatch = createExecuteBatch(recordingFetch().fetchImpl);

    await assert.rejects(
      executeBatch(makeCtx(), { operations: [] }),
      (err: Error) => err.name === 'ValidationError',
    );
    await assert.rejects(
      executeBatch(makeCtx(), {
        operations: Array.from({ length: MAX_BATCH_OPERATIONS + 1 }, (_, i) => ({
          id: String(i),
          path: '/api/market/v1/get-fear-greed-index',
        })),
      }),
      (err: Error) => err.name === 'ValidationError',
    );
    await assert.rejects(
      executeBatch(makeCtx(), {
        operations: [
          { id: 'dup', path: '/api/market/v1/get-fear-greed-index' },
          { id: 'dup', path: '/api/market/v1/list-market-quotes' },
        ],
      }),
      (err: Error) => err.name === 'ValidationError',
    );
  });

  it('maps transport failures to per-operation error codes', async () => {
    const timeoutErr = Object.assign(new Error('timed out'), { name: 'TimeoutError' });
    const executeBatch = createExecuteBatch(async (url) => {
      if (url.includes('list-market-quotes')) throw timeoutErr;
      if (url.includes('get-fear-greed-index')) throw new TypeError('fetch failed');
      return new Response('not json at all', { status: 200 });
    });

    const res = await executeBatch(makeCtx(), {
      operations: [
        { id: 'to', path: '/api/market/v1/list-market-quotes' },
        { id: 'net', path: '/api/market/v1/get-fear-greed-index' },
        { id: 'bad', path: '/api/market/v1/list-crypto-quotes' },
      ],
    });

    assert.deepEqual(res.results[0], { id: 'to', status: 0, error: 'timeout' });
    assert.deepEqual(res.results[1], { id: 'net', status: 0, error: 'fetch_failed' });
    assert.equal(res.results[2]!.error, 'invalid_json');
    assert.equal(res.results[2]!.status, 200);
    assert.equal(res.succeeded, 0);
    assert.equal(res.failed, 3);
  });

  it('caps per-operation response size via Content-Length', async () => {
    const executeBatch = createExecuteBatch(async () =>
      new Response('{}', {
        status: 200,
        headers: { 'Content-Length': String(MAX_SUB_RESPONSE_BYTES + 1) },
      }),
    );

    const res = await executeBatch(makeCtx(), {
      operations: [{ id: 'big', path: '/api/market/v1/get-fear-greed-index' }],
    });

    assert.equal(res.results[0]!.error, 'response_too_large');
    assert.equal(res.failed, 1);
  });
});
