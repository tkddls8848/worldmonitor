import { afterEach, beforeEach, test } from 'node:test';
import { expect, vi } from './helpers/vitest-compat.mts';
import { createDomainGateway } from '../server/gateway';
import { searchImagery } from '../server/worldmonitor/imagery/v1/search-imagery';
import { createImageryServiceRoutes } from '../src/generated/server/worldmonitor/imagery/v1/service_server';
import { __resetKeyPrefixCacheForTests } from '../server/_shared/redis';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

const PATH = '/api/imagery/v1/search-imagery';
const env = { ...process.env };
let providerCalls: number;
let redisError: boolean;
let limiterKeys: string[];
let gateway: ReturnType<typeof createDomainGateway>;

beforeEach(() => {
  providerCalls = 0; redisError = false; limiterKeys = [];
  process.env.UPSTASH_REDIS_REST_URL = 'https://imagery-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  delete process.env.AXIOM_TOKEN;
  __resetKeyPrefixCacheForTests();
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  const redis = createRedisFetch({});
  const counters = new Map<string, number>();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'imagery-redis.invalid') {
      if (init?.body) {
        const command = JSON.parse(String(init.body));
        if (Array.isArray(command[0])) {
          if (redisError) return Response.json({ error: 'Synthetic outage' }, { status: 503 });
          return Response.json(command.map((entry: unknown[]) => {
            expect(String(entry[0])).toMatch(/^eval(sha)?$/i);
            const key = String(entry[3]);
            limiterKeys.push(key);
            const limit = Number(entry[3 + Number(entry[2])]);
            const count = (counters.get(key) ?? 0) + 1;
            counters.set(key, count);
            return { result: [limit - count, limit] };
          }));
        }
      }
      return redis.fetchImpl(input, init);
    }
    expect(url.href).toBe('https://earth-search.aws.element84.com/v1/search');
    providerCalls++;
    return Response.json({ features: [], numberMatched: 0 });
  });
  const routes = createImageryServiceRoutes({ searchImagery });
  gateway = createDomainGateway([...routes, { ...routes[0]!, path: '/api/economic/v1/list-world-bank-indicators' }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  __resetKeyPrefixCacheForTests();
});

async function request(index = 1, session = true, path = PATH) {
  const cookie = session ? { Cookie: `wm-session=${'wms_test-browser-session'}` } : {};
  const query = new URLSearchParams({ bbox: `${index / 1000},0,1,1`, datetime: '2026-08-01T00:00:00Z' });
  return gateway(new Request(`https://worldmonitor.app${path}?${query}`, {
    headers: { 'x-real-ip': '192.0.2.54', ...cookie },
  }), { waitUntil: () => {} });
}

test('invalid datetime returns a field violation before STAC', async () => {
  const routes = createImageryServiceRoutes({ searchImagery });
  const response = await routes[0]!.handler(new Request(`https://worldmonitor.app${PATH}?bbox=0,0,1,1&datetime=invalid`), {});
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ violations: [{ field: 'datetime', description: 'Invalid imagery datetime' }] });
  expect(providerCalls).toBe(0);
});
