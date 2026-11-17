import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { searchPricesTravelpayouts } from '../server/worldmonitor/aviation/v1/_providers/travelpayouts_data.ts';
import { createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest, checkEndpointRateLimit, ENDPOINT_RATE_POLICIES } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { validationFailure } from './helpers/validation-failure.mts';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
const PATH = '/api/aviation/v1/search-flight-prices';
const KEY = 'synthetic-flight-key';
const base = { origin: 'IST', destination: 'LHR', departureDate: '2028-02-29', returnDate: '', cabin: 'CABIN_CLASS_ECONOMY', nonstopOnly: false, maxResults: 5, currency: 'usd', market: 'us', token: 'synthetic-provider-token' };
let calls: URL[];
let redis: ReturnType<typeof installRedis>;

beforeEach(() => {
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  delete process.env.AVIATION_DEMO_PRICES;
  process.env.WORLDMONITOR_VALID_KEYS = KEY;
  process.env.TRAVELPAYOUTS_API_TOKEN = base.token;
  __resetRateLimitForTest();
  calls = [];
  redis = installRedis({});
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    calls.push(url);
    if (url.hostname === 'api.travelpayouts.com') return Response.json({ success: true, data: [] });
    return redis.fetchImpl(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});

function request(overrides: Record<string, string> = {}, withKey = true) {
  const params = new URLSearchParams({ origin: 'IST', destination: 'LHR', departure_date: '2028-02-29', cabin: 'CABIN_CLASS_ECONOMY', currency: 'usd', market: 'us', ...overrides });
  return new Request(`https://api.worldmonitor.app${PATH}?${params}`, { headers: withKey ? { 'X-WorldMonitor-Key': KEY, 'x-vercel-forwarded-for': '192.0.2.1' } : {} });
}
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
const providerCalls = () => calls.filter(url => url.hostname === 'api.travelpayouts.com');

const WIRE: Record<string, string> = { departureDate: 'departure_date', returnDate: 'return_date' };

describe('Travelpayouts input boundary', () => {
  for (const [field, value] of [
    ['origin', 'A:B'], ['destination', 'AB1'], ['origin', 'KJFK'],
    ['departureDate', 'xxxxxxxxxx'], ['departureDate', '2028-13-01'],
    ['departureDate', '2027-02-29'], ['returnDate', 'x'.repeat(1000)],
    ['returnDate', '2028-02-30'], ['currency', 'usd:nonce'], ['currency', 'zzz'],
    ['market', 'us:nonce'], ['market', 'zz'], ['cabin', 'constructor'], ['cabin', 'CABIN_CLASS_CUSTOM'],
  ]) {
    it(`rejects invalid ${field} before any cache or provider work: ${value.slice(0, 24)}`, async () => {
      await assert.rejects(searchPricesTravelpayouts({ ...base, [field]: value }), validationFailure(WIRE[field] ?? field));
      assert.equal(calls.length, 0);
      assert.equal(redis.redis.size, 0);
    });
  }

  it('normalizes equivalent input into one upstream request and cache entry', async () => {
    await searchPricesTravelpayouts(base);
    await searchPricesTravelpayouts({ ...base, origin: 'ist', destination: 'lhr', currency: 'USD', market: 'US', cabin: 'CABIN_CLASS_UNSPECIFIED' });
    assert.equal(providerCalls().length, 1);
    const params = providerCalls()[0]!.searchParams;
    assert.equal(params.get('origin'), 'IST');
    assert.equal(params.get('currency'), 'usd');
    assert.equal(params.get('market'), 'us');
  });

  it('retains valid month and latest searches and caps provider results', async () => {
    await searchPricesTravelpayouts({ ...base, departureDate: '2028-02' });
    await searchPricesTravelpayouts({ ...base, departureDate: '', maxResults: 50 });
    assert.deepEqual(providerCalls().map(url => url.pathname), ['/v2/prices/month-matrix', '/v2/prices/latest']);
    assert.equal(providerCalls()[1]!.searchParams.get('limit'), '30');
  });

  it('preserves inferred market, currency and cabin defaults and valid return months', async () => {
    await searchPricesTravelpayouts({ ...base, currency: '', market: '', cabin: '', returnDate: '2028-03' });
    await searchPricesTravelpayouts({ ...base, currency: 'usd', market: 'tr', returnDate: '2028-03' });
    assert.equal(providerCalls().length, 1);
    const params = providerCalls()[0]!.searchParams;
    assert.equal(params.get('market'), 'tr');
    assert.equal(params.get('return_at'), '2028-03');
    assert.equal(params.get('trip_class'), '0');
  });

  it('rejects malformed generated RPC input with HTTP400, without a provider call', async () => {
    const response = await gateway(request({ currency: 'usd:nonce' }));
    assert.equal(response.status, 400);
    assert.equal(providerCalls().length, 0);
    assert.ok([...redis.redis.keys()].every(key => !key.startsWith('tp:') && !key.startsWith('aviation:price-snapshot:')));
  });



});
