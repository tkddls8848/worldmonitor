// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { createDomainGateway } from '../gateway';
import { getWingbitsLiveFlight } from '../worldmonitor/military/v1/get-wingbits-live-flight';
import { createMilitaryServiceRoutes, type MilitaryServiceHandler } from '../../src/generated/server/worldmonitor/military/v1/service_server';
import { __resetKeyPrefixCacheForTests } from '../_shared/redis';

const PATH = '/api/military/v1/get-wingbits-live-flight';
const env = { ...process.env };
let cache: Map<string, string>;
let counters: Map<string, number>;
let providerCalls: URL[];
let limiterKeys: string[];
let redisError: boolean;
let gateway: ReturnType<typeof createDomainGateway>;

beforeEach(() => {
  cache = new Map(); counters = new Map(); providerCalls = []; limiterKeys = []; redisError = false;
  process.env.UPSTASH_REDIS_REST_URL = 'https://wingbits-redis.invalid';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  process.env.VERCEL_ENV = 'production';
  delete process.env.LOCAL_API_MODE;
  delete process.env.AXIOM_TOKEN;
  delete process.env.WINGBITS_API_KEY;
  __resetKeyPrefixCacheForTests();
  vi.spyOn(Date, 'now').mockReturnValue(1700000000000);
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'wingbits-redis.invalid') {
      if (url.pathname.startsWith('/get/')) {
        return Response.json({ result: cache.get(decodeURIComponent(url.pathname.slice(5))) ?? null });
      }
      const command = JSON.parse(String(init?.body));
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
      expect(command[0]).toBe('SET');
      cache.set(command[1], command[2]);
      return Response.json({ result: 'OK' });
    }
    expect(['ecs-api.wingbits.com', 'api.planespotters.net']).toContain(url.hostname);
    providerCalls.push(url);
    const headers = new Headers(init?.headers);
    expect(headers.get('x-api-key')).toBeNull();
    expect(headers.get('Authorization')).toBeNull();
    expect(headers.get('User-Agent')).toBeTruthy();
    if (url.hostname === 'api.planespotters.net') {
      return Response.json({ photos: [{ thumbnail_large: { src: 'https://photos.invalid/example.jpg' }, link: 'https://photos.invalid/photo', photographer: 'Synthetic' }] });
    }
    if (url.pathname.includes('/schedule/UAE')) return Response.json({});
    if (url.pathname.includes('/schedule/EK')) return Response.json({ schedule: { depIata: 'DXB', arrIata: 'LHR', status: 'en-route' } });
    const hex = url.pathname.split('/').at(-1)!;
    return Response.json({ flight: { h: hex, f: `UAE${parseInt(hex, 16)}`, la: 25, lo: 55, ab: 30000 } });
  });
  const routes = createMilitaryServiceRoutes({ getWingbitsLiveFlight } as MilitaryServiceHandler).filter(route => route.path === PATH);
  gateway = createDomainGateway([...routes, { ...routes[0]!, path: '/api/economic/v1/list-world-bank-indicators' }]);
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
  Object.assign(process.env, env);
  __resetKeyPrefixCacheForTests();
});
async function request(hex = '000001', session = true, path = PATH) {
  const cookie = session ? { Cookie: `wm-session=${'wms_test-browser-session'}` } : {};
  return gateway(new Request(`https://worldmonitor.app${path}?icao24=${hex}`, { headers: { 'x-real-ip': '192.0.2.47', ...cookie } }), { waitUntil: () => {} });
}

test('ordinary session retains full live/schedule/photo response and no-store caching', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  const { flight } = await response.json();
  expect(flight).toMatchObject({ icao24: '000001', callsignIata: 'EK1', depIata: 'DXB', arrIata: 'LHR', lat: 25, lon: 55, photoCredit: 'Synthetic' });
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('CDN-Cache-Control')).toBeNull();
  expect(providerCalls).toHaveLength(4);
  expect((await request()).status).toBe(200);
  expect(providerCalls).toHaveLength(4);
});
test('baseline global policy allows the 31st unique aircraft lookup', async () => {
  for (let i = 1; i <= 31; i++) expect((await request(i.toString(16).padStart(6, '0'))).status).toBe(200);
  expect(providerCalls).toHaveLength(124);
});
test('baseline without Redis still reaches provider', async () => {
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  expect((await request()).status).toBe(200);
  expect(providerCalls).toHaveLength(4);
});
