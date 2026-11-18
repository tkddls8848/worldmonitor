import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import type { SearchGoogleFlightsRequest } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { searchGoogleFlights } from '../server/worldmonitor/aviation/v1/search-google-flights.ts';
import { ValidationError, createAviationServiceRoutes } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { readLimiterRequest } from './helpers/upstash-limiter-wire.mjs';
import { decodeTfs, loadGoogleFlightsRelay, pageFixture, relayTransport, resultsPage } from './helpers/google-flights-page.mts';
import { issueSessionToken } from '../api/_session.js';
import { RpcValidationError, assertToolFetchOk } from '../api/mcp/billing-denial.ts';
const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const PATH = '/api/aviation/v1/search-google-flights';
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
let redis: ReturnType<typeof installRedis>;
let calls: URL[];
let session: string;
beforeEach(async () => {
  delete process.env.WORLDMONITOR_VALID_KEYS;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  process.env.WS_RELAY_URL = 'https://relay.example';
  delete process.env.LOCAL_API_MODE;
  process.env.WM_SESSION_SECRET = 'synthetic-aviation-news-session-secret';
  session = (await issueSessionToken()).token;
  redis = installRedis({});
  calls = [];
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    return Response.json({ flights: [] });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});
const defaults: SearchGoogleFlightsRequest = { origin: 'DXB', destination: 'LHR', departureDate: '2026-10-01', returnDate: '', cabinClass: '', maxStops: '', departureWindow: '', airlines: [], sortBy: '', passengers: 1 };
const request = (overrides: Record<string, string> = {}) => new Request(`https://api.worldmonitor.app${PATH}?${new URLSearchParams({ origin: 'DXB', destination: 'LHR', departure_date: '2026-10-01', ...overrides })}`, { headers: { 'X-WorldMonitor-Key': session, 'x-vercel-forwarded-for': '192.0.2.9' } });
const ctx = () => ({ request: request(), pathParams: {}, headers: {} });
const feeds = () => calls.filter(url => url.hostname !== 'redis.example');
const read = (overrides: Partial<typeof defaults> = {}) => searchGoogleFlights(ctx(), { ...defaults, ...overrides });

test('rejects malformed or oversized inputs before cache or relay work', async () => {
  const invalid = [{ origin: 'X'.repeat(1000) }, { departureDate: '' }, { departureDate: '2026-2-01' }, { departureDate: '2026-02-29' }, { destination: 'A/B' }, { departureDate: '2026-02-30' }, { returnDate: '2026-09-30' }, { returnDate: 'junk' }, { cabinClass: 'arbitrary' }, { maxStops: '3' }, { sortBy: 'junk' }, { departureWindow: '25-26' }, { departureWindow: '20-6' }, { airlines: ['BAD'] }, { airlines: Array(11).fill('BA') }, { cabinClass: ' '.repeat(1000) }, { sortBy: ' '.repeat(1000) }, { departureDate: '2026-10-01 ' }, { airlines: [' '.repeat(1000) + 'BA'] }];
  for (const value of invalid) {
    await assert.rejects(read(value), (error: unknown) => error instanceof ValidationError && error.violations.length === 1);
    assert.equal(calls.length, 0);
  }
});
test('canonical equivalents share bounded hashed cache identity', async () => {
  await read({ origin: ' dxb ', cabinClass: 'economy', maxStops: '0', sortBy: 'price', airlines: ['ba', 'AA', 'BA'], departureWindow: '06-20', passengers: 99 });
  await read({ cabinClass: 'ECONOMY', maxStops: 'NON_STOP', sortBy: 'CHEAPEST', airlines: ['AA', 'BA'], departureWindow: '6-20', passengers: 9 });
  assert.equal(feeds().length, 1);
  assert.deepEqual(feeds()[0]!.searchParams.getAll('airlines'), ['AA', 'BA']);
  const keys = [...redis.redis.keys()].filter(key => key.startsWith('aviation:gf:'));
  assert.equal(keys.length, 1);
  assert.match(keys[0]!, /^aviation:gf:[a-f0-9]{64}:v2$/);
  assert.equal(redis.expires.get(keys[0]!), 600);
});
test('fractional passenger counts share the integer relay query and cache entry', async () => {
  await read({ passengers: 1.9 });
  await read({ passengers: 1 });
  assert.equal(feeds().length, 1);
  assert.equal(feeds()[0]!.searchParams.get('passengers'), '1');
});
test('an MCP caller sees which argument was rejected, not an internal error', async () => {
  const response = await gateway(request({ return_date: '2026-09-01' }));
  await assert.rejects(assertToolFetchOk(response, 'search-google-flights'), (error: unknown) => {
    assert.ok(error instanceof RpcValidationError);
    assert.deepEqual(error.violations, [{ field: 'return_date', description: 'Return date must not precede departure date' }]);
    return true;
  });
});
test('ordinary gateway rejects bad input without upstream work', async () => {
  assert.equal((await gateway(request({ origin: 'TOOLONG' }))).status, 400);
  assert.equal(feeds().length, 0);
});
test('effective options remain distinct while defaults and sort aliases share keys', async () => {
  await read();
  await read({ cabinClass: 'economy', maxStops: 'any' });
  assert.equal(feeds().length, 1);
  for (const option of [{ returnDate: '2026-10-05' }, { cabinClass: 'BUSINESS' }, { maxStops: 'NON_STOP' }, { sortBy: 'CHEAPEST' }, { passengers: 2 }, { airlines: ['BA'] }, { departureWindow: '6-20' }]) await read(option);
  assert.equal(feeds().length, 8);
  await read({ sortBy: 'PRICE' });
  assert.equal(feeds().length, 8);
  await read({ sortBy: 'DEPARTURE' });
  await read({ sortBy: 'DEPARTURE_TIME' });
  await read({ sortBy: 'ARRIVAL' });
  await read({ sortBy: 'ARRIVAL_TIME' });
  assert.equal(feeds().length, 10);
});

test('real relay search reads one results page with every filter in tfs, then applies the window and sort', async () => {
  const pages: URL[] = [];
  const relay = loadGoogleFlightsRelay((async (input) => {
    pages.push(new URL(String(input)));
    return new Response(resultsPage([
      { price: 500, departure: [7, 0], date: '2028-02-29' },
      { price: 300, departure: [19, 0], date: '2028-02-29' },
      { price: 200, departure: [21, 0], date: '2028-02-29', stops: 1 },
    ]));
  }) as typeof fetch);
  globalThis.fetch = relayTransport(relay.search, globalThis.fetch);
  const query = { departureDate: '2028-02-29', returnDate: '2028-03-07', cabinClass: 'business', maxStops: '1', sortBy: 'price', departureWindow: '18-24', passengers: 3, airlines: ['U2', 'BA'] };
  const first = await read(query);
  assert.deepEqual(first.flights.map(f => [f.price, f.legs[0]!.departureDatetime]), [[200, '2028-02-29T21:00'], [300, '2028-02-29T19:00']]);
  assert.deepEqual(await read(query), first);
  assert.equal(pages.length, 1);
  assert.equal(pages[0]!.origin + pages[0]!.pathname, 'https://www.google.com/travel/flights/search');
  assert.deepEqual(decodeTfs(pages[0]!), {
    legs: [
      { date: '2028-02-29', maxStops: 1, airlines: ['BA', 'U2'], from: 'DXB', to: 'LHR' },
      { date: '2028-03-07', maxStops: 1, airlines: ['BA', 'U2'], from: 'LHR', to: 'DXB' },
    ],
    adults: 3,
    seat: 3,
    trip: 1,
  });
});

test('the captured JFK-LHR results page parses to its live itineraries', async () => {
  globalThis.fetch = relayTransport(loadGoogleFlightsRelay((async () => new Response(pageFixture('jfk-lhr-2026-11-15.html'))) as typeof fetch).search, globalThis.fetch);
  const { flights, degraded } = await read({ origin: 'JFK', departureDate: '2026-11-15', maxStops: 'ANY' });
  assert.equal(degraded, false);
  assert.equal(flights.length, 23);
  assert.deepEqual(flights[0], {
    legs: [{ airlineCode: 'VS', flightNumber: '26', departureAirport: 'JFK', arrivalAirport: 'LHR', departureDatetime: '2026-11-15T08:00', arrivalDatetime: '2026-11-15T20:10', durationMinutes: 430 }],
    price: 295, durationMinutes: 430, stops: 0,
  });
  assert.equal(Math.min(...flights.map(f => f.price)), 293);
  assert.ok(flights.some(f => f.stops === 1 && f.legs.length === 2));
});

test('a route with no service is an empty search, not a failure', async () => {
  globalThis.fetch = relayTransport(loadGoogleFlightsRelay((async () => new Response(pageFixture('bti-lhr-no-service.html'))) as typeof fetch).search, globalThis.fetch);
  assert.deepEqual(await read({ origin: 'BTI', departureDate: '2026-11-15' }), { flights: [], degraded: false, error: '' });
});
test('upstream failure remains degraded and is not cached as a successful search', async () => {
  const transport = globalThis.fetch;
  let attempts = 0;
  globalThis.fetch = (async (input, init) => {
    if (new URL(String(input)).hostname !== 'relay.example') return transport(input, init);
    attempts++;
    return attempts === 1 ? new Response('failure', { status: 502 }) : Response.json({ flights: [] });
  }) as typeof fetch;
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    const failed = await read();
    assert.equal(failed.degraded, true);
    assert.deepEqual(failed.flights, []);
    assert.equal((await read()).degraded, false);
    assert.equal(attempts, 2);
  } finally {
    Date.now = realNow;
  }
});

test('provider cooldown remains degraded and is never stored as a healthy empty search', async () => {
  let attempts = 0;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input));
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    attempts++;
    return Response.json({ flights: [], cooldown: true, error: 'provider cooldown' });
  }) as typeof fetch;

  const first = await read();
  const second = await read();
  assert.deepEqual(first, { flights: [], degraded: true, error: 'provider cooldown' });
  assert.deepEqual(second, { flights: [], degraded: true, error: 'provider cooldown' });
  assert.equal(attempts, 2, 'cooldown must not be cached as a successful empty result');
  assert.equal([...redis.redis.keys()].filter(key => key.startsWith('aviation:gf:')).length, 0);
});

test('a page without results or a Google error page reaches the caller as a degraded search', async () => {
  for (const [page, reason] of [
    ['<html><body>Our systems have detected unusual traffic</body></html>', 'Google Flights returned a page without flight results'],
    [pageFixture('jfk-lhr-past-date.html'), 'Google Flights rejected the search'],
  ] as const) {
    const outcomes: string[] = [];
    const transport = globalThis.fetch;
    globalThis.fetch = relayTransport(loadGoogleFlightsRelay((async () => new Response(page)) as typeof fetch, outcomes).search, transport);
    const result = await read({ origin: 'JFK', departureDate: '2026-11-15' });
    globalThis.fetch = transport;
    assert.equal(result.degraded, true);
    assert.deepEqual(result.flights, []);
    assert.ok(result.error.startsWith(`relay returned 502: ${reason}`), result.error);
    assert.deepEqual(outcomes, ['terminalFailure']);
    assert.equal([...redis.redis.keys()].filter(key => key.startsWith('aviation:gf:')).length, 0);
  }
});
