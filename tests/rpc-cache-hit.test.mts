import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { searchImagery } from '../server/worldmonitor/imagery/v1/search-imagery.ts';

const ENV_KEYS = [
  'LOCAL_API_MODE',
  'UPSTASH_REDIS_REST_TOKEN',
  'UPSTASH_REDIS_REST_URL',
  'VERCEL_ENV',
  'VERCEL_GIT_COMMIT_SHA',
  'WORLDMONITOR_VALID_KEYS',
  'WS_RELAY_URL',
] as const;

const originalEnv = new Map<string, string | undefined>();
const originalFetch = globalThis.fetch;

type RedisSetCommand = ['SET', string, string, 'EX', string];
type FetchMockOptions = { stac?: 'network-error' };

beforeEach(() => {
  for (const key of ENV_KEYS) {
    originalEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.test';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'redis-token';
  process.env.VERCEL_ENV = 'production';
  process.env.WORLDMONITOR_VALID_KEYS = 'test-key';
  process.env.WS_RELAY_URL = 'https://relay.test';
});

afterEach(() => {
  mock.restoreAll();
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    const value = originalEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  originalEnv.clear();
});

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function installFetchMock(options: FetchMockOptions = {}) {
  const cache = new Map<string, string>();
  const calls = {
    relay: 0,
    stac: 0,
    redisSets: [] as RedisSetCommand[],
  };

  mock.method(globalThis, 'fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);

    if (url.startsWith('https://redis.test/get/')) {
      const key = decodeURIComponent(url.slice('https://redis.test/get/'.length));
      return jsonResponse({ result: cache.get(key) ?? null });
    }

    if (url === 'https://redis.test/') {
      const command = JSON.parse(String(init?.body ?? '[]')) as RedisSetCommand;
      assert.equal(command[0], 'SET');
      calls.redisSets.push(command);
      cache.set(command[1], command[2]);
      return jsonResponse({ result: 'OK' });
    }

    if (url === 'https://earth-search.aws.element84.com/v1/search') {
      calls.stac += 1;
      if (options.stac === 'network-error') throw new Error('STAC unavailable');
      return jsonResponse({
        features: [{
          id: 'sentinel-2-scene',
          properties: { datetime: '2026-08-01T00:00:00Z', constellation: 'sentinel-2' },
          geometry: { type: 'Point', coordinates: [0, 0] },
        }],
        numberMatched: 1,
      });
    }


    throw new Error(`unexpected fetch: ${url}`);
  });

  return calls;
}

function redisPayloads(calls: ReturnType<typeof installFetchMock>): unknown[] {
  return calls.redisSets.map(([, , payload]) => JSON.parse(payload));
}

function assertOnlyNegativeSentinels(calls: ReturnType<typeof installFetchMock>) {
  const payloads = redisPayloads(calls);
  assert.ok(payloads.length > 0, 'expected at least one Redis SET');
  assert.deepEqual([...new Set(payloads)], ['__WM_NEG__']);
}

function flightContext() {
  return {
    request: new Request('https://worldmonitor.app/api/aviation/v1/get-flight-status?flight_number=TK1952&date=2026-08-01', {
      headers: { 'X-WorldMonitor-Key': 'test-key' },
    }),
    pathParams: {},
    headers: {},
  };
}

describe('RPC cache-hit reporting', { concurrency: 1 }, () => {
  it('reports a fresh imagery search as a miss and its immediate repeat as a hit', async () => {
    const calls = installFetchMock();
    const request = {
      bbox: '0,0,1,1',
      datetime: '2026-07-25T00:00:00Z/2026-08-01T00:00:00Z',
      source: 'sentinel-2',
      limit: 5,
    };

    const cold = await searchImagery({} as never, request);
    const warm = await searchImagery({} as never, request);

    assert.equal(cold.cacheHit, false);
    assert.equal(warm.cacheHit, true);
    assert.equal(calls.stac, 1, 'the repeat must use the cached STAC result');
  });

  it('serves requests differing only in source casing from one cache entry (#7209)', async () => {
    const calls = installFetchMock();
    const base = {
      bbox: '0,0,1,1',
      datetime: '2026-07-25T00:00:00Z/2026-08-01T00:00:00Z',
      limit: 5,
    };

    const cold = await searchImagery({} as never, { ...base, source: 'sentinel-2' });
    const upper = await searchImagery({} as never, { ...base, source: 'SENTINEL-2' });
    const padded = await searchImagery({} as never, { ...base, source: ' Sentinel-2 ' });

    assert.equal(cold.cacheHit, false);
    assert.equal(upper.cacheHit, true, 'casing is meaningless to the handler and must not split the cache');
    assert.equal(padded.cacheHit, true, 'stray whitespace must not split the cache either');
    assert.equal(calls.stac, 1, 'one STAC round-trip for all three spellings');
  });

  it('reports a cached imagery failure as a hit without retrying STAC', async () => {
    const calls = installFetchMock({ stac: 'network-error' });
    const request = {
      bbox: '0,0,1,1',
      datetime: '2026-07-25T00:00:00Z/2026-08-01T00:00:00Z',
      source: 'sentinel-2',
      limit: 5,
    };

    const cold = await searchImagery({} as never, request);
    const warm = await searchImagery({} as never, request);

    assert.equal(cold.cacheHit, false);
    assert.equal(warm.cacheHit, true);
    assert.equal(calls.stac, 1, 'the cached failure must not retry STAC');
    assert.deepEqual(cold.scenes, []);
    assert.equal(cold.totalResults, 0);
    assert.deepEqual(warm.scenes, []);
    assert.equal(warm.totalResults, 0);
    assertOnlyNegativeSentinels(calls);
  });

});
