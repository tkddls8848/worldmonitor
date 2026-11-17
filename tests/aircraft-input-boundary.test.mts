import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { trackAircraft } from '../server/worldmonitor/aviation/v1/track-aircraft.ts';
import { ApiError, createAviationServiceRoutes, type TrackAircraftRequest } from '../src/generated/server/worldmonitor/aviation/v1/service_server.ts';
import { aviationHandler } from '../server/worldmonitor/aviation/v1/handler.ts';
import { createDomainGateway, serverOptions } from '../server/gateway.ts';
import { __resetRateLimitForTest, ENDPOINT_RATE_POLICIES, FAIL_CLOSED_ENDPOINT_RATE_POLICY_REQUIRED } from '../server/_shared/rate-limit.ts';
import { installRedis } from './helpers/fake-upstash-redis.mts';
import { readLimiterRequest } from './helpers/upstash-limiter-wire.mjs';
import { issueSessionToken } from '../api/_session.js';
import { validationFailure } from './helpers/validation-failure.mts';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };
const PATH = '/api/aviation/v1/track-aircraft';
const gateway = createDomainGateway(createAviationServiceRoutes(aviationHandler, serverOptions));
const defaults: TrackAircraftRequest = { icao24: '', callsign: '', swLat: 0, swLon: 0, neLat: 0, neLon: 0 };
const wingbitsPosition = { icao24: 'abc123', callsign: 'UAE20', lat: 25, lon: 55, altitudeM: 1000, groundSpeedKts: 100, trackDeg: 90, verticalRate: 0, onGround: false, source: 'POSITION_SOURCE_WINGBITS', observedAt: 1 };
let redis: ReturnType<typeof installRedis>;
let calls: URL[];
let session: string;
let wingbitsStatus: number;
let wingbitsPositions: typeof wingbitsPosition[];
let openSkyStatus: number;
beforeEach(async () => {
  delete process.env.LOCAL_API_MODE;
  delete process.env.WORLDMONITOR_VALID_KEYS;
  delete process.env.VERCEL;
  delete process.env.VERCEL_ENV;
  process.env.WS_RELAY_URL = 'https://relay.example';
  process.env.WM_SESSION_SECRET = 'synthetic-aircraft-session-secret';
  session = (await issueSessionToken()).token;
  __resetRateLimitForTest();
  redis = installRedis({});
  calls = [];
  wingbitsStatus = 200;
  wingbitsPositions = [wingbitsPosition];
  openSkyStatus = 200;
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); calls.push(url);
    if (url.hostname === 'redis.example') return redis.fetchImpl(input, init);
    assert.equal(url.hostname, 'relay.example');
    if (url.pathname === '/wingbits/track') return Response.json({ positions: wingbitsPositions, source: 'wingbits' }, { status: wingbitsStatus });
    assert.equal(url.pathname, '/opensky/states/all');
    return Response.json({ states: [['abc123', 'UAE20 ', null, null, 1, 55, 25, 1000, false, 100, 90, 0]] }, { status: openSkyStatus });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
  __resetRateLimitForTest();
});
const request = (query: Record<string, string> = {}) => new Request(`https://api.worldmonitor.app${PATH}?${new URLSearchParams(query)}`, { headers: { 'X-WorldMonitor-Key': session, 'x-real-ip': '192.0.2.10' } });
const ctx = () => ({ request: request(), pathParams: {}, headers: {} });
const read = (options: Partial<TrackAircraftRequest>) => trackAircraft(ctx(), { ...defaults, ...options });
const providers = () => calls.filter(url => url.hostname === 'relay.example');

test('invalid or oversized identifiers fail before cache or upstream I/O', async () => {
  for (const options of [{ icao24: 'abc123&lamin=0' }, { icao24: 'abc12' }, { icao24: 'gggggg' }, { icao24: 'a'.repeat(1000) }, { callsign: 'UAE/20' }, { callsign: 'UAE20&x=1' }, { callsign: 'ABCDEFGHI' }, { callsign: ' '.repeat(1000) + 'UAE20' }]) {
    await assert.rejects(read(options), validationFailure(Object.keys(options)[0]!));
    assert.equal(calls.length, 0);
  }
});
test('canonical ICAO shares bounded key and retains OpenSky lookup/filter behavior', async () => {
  const first = await read({ icao24: ' ABC123 ' });
  const second = await read({ icao24: 'abc123' });
  assert.equal(first.source, 'opensky');
  assert.equal(first.positions[0]?.icao24, 'abc123');
  assert.deepEqual(second.positions, first.positions);
  assert.equal(providers().length, 1);
  assert.equal(providers()[0]!.search, '?icao24=abc123');
  assert.deepEqual([...redis.redis.keys()].filter(key => key.startsWith('aviation:track:')), ['aviation:track:icao:abc123:v2']);
});
test('canonical callsign retains substring matching and Wingbits priority', async () => {
  assert.equal((await read({ callsign: ' uae ' })).positions[0]?.callsign, 'UAE20');
  assert.equal((await read({ callsign: 'UAE' })).source, 'wingbits');
  assert.equal(providers().length, 1);
  assert.equal(providers()[0]!.search, '?callsign=UAE');
  assert.deepEqual([...redis.redis.keys()].filter(key => key.startsWith('aviation:track:')), ['aviation:track:callsign:UAE:v2']);
});
test('identifier provider failures preserve empty none responses and no-identifier requests do not fetch', async () => {
  wingbitsStatus = 502;
  assert.equal((await read({ callsign: 'FAIL1' })).source, 'none');
  assert.equal(providers().length, 1);
  openSkyStatus = 502;
  assert.equal((await read({ icao24: 'fffffe' })).source, 'none');
  assert.equal(providers().length, 2);
  assert.deepEqual((await read({})).positions, []);
  assert.equal(providers().length, 2);
});
test('both identifiers and identifiers with bbox are validated and admitted without changing filtering', async () => {
  const both = await read({ icao24: 'ABC123', callsign: ' uae ' });
  assert.equal(both.source, 'opensky');
  assert.equal(both.positions[0]?.icao24, 'abc123');
  const withBbox = await read({ icao24: 'abc123', callsign: 'UAE', swLat: 24, swLon: 54, neLat: 26, neLon: 56 });
  assert.equal(withBbox.positions[0]?.icao24, 'abc123');
  await assert.rejects(read({ icao24: 'bad', swLat: 24, swLon: 54, neLat: 26, neLon: 56 }), validationFailure('icao24'));
});
test('nearby exact viewports keep separate data and filter provider overfetch on cache hits', async () => {
  wingbitsPositions = [{ ...wingbitsPosition, lat: 25.2, lon: 55.2 }, { ...wingbitsPosition, lat: 25.8, lon: 55.8 }];
  const west = { swLat: 25.1, swLon: 55.1, neLat: 25.5, neLon: 55.5 };
  const east = { swLat: 25.6, swLon: 55.6, neLat: 25.9, neLon: 55.9 };
  assert.deepEqual((await read(west)).positions.map(p => p.lat), [25.2]);
  assert.deepEqual((await read(east)).positions.map(p => p.lat), [25.8]);
  assert.deepEqual((await read(west)).positions.map(p => p.lat), [25.2]);
  assert.equal(providers().length, 2);
  assert.equal(providers()[0]!.searchParams.get('lamin'), '25.1');
  assert.equal(providers()[1]!.searchParams.get('lamin'), '25.6');
});

test('viewport fetch identity includes identifiers and stays separate from identifier-only data', async () => {
  await read({ icao24: 'abc123' });
  const bbox = { swLat: 24, swLon: 54, neLat: 26, neLon: 56 };
  assert.equal((await read({ ...bbox, icao24: 'abc123' })).source, 'wingbits');
  await read({ ...bbox, icao24: 'def456' });
  assert.equal(providers().length, 3);
});

test('normalized viewport coordinates determine both cache identity and relay query', async () => {
  const reversed = { swLat: 100, swLon: 200, neLat: 24, neLon: 54 };
  await read(reversed);
  await read({ swLat: 24, swLon: 54, neLat: 90, neLon: 180 });
  assert.equal(providers().length, 1);
  assert.equal(providers()[0]!.search, '?lamin=24&lomin=54&lamax=90&lomax=180');
});

test('nonfinite viewport coordinates reject before cache or provider work', async () => {
  for (const swLat of [NaN, Infinity, -Infinity]) {
    await assert.rejects(read({ swLat, neLat: 26, swLon: 54, neLon: 56 }), validationFailure('sw_lat', /finite viewport/));
    assert.equal(calls.length, 0);
  }
});

for (const status of [400, 401, 403, 404, 422]) test(`Wingbits bbox ${status} does not authorize OpenSky`, async () => {
  wingbitsStatus = status;
  const result = await read({ swLat: 24, swLon: 54, neLat: 26, neLon: 56 });
  assert.equal(result.source, 'none');
  assert.deepEqual(providers().map(url => url.pathname), ['/wingbits/track']);
});
test('oversized bbox answers empty before cache/provider work', async () => {
  for (const options of [
    { swLat: -90, swLon: -180, neLat: 90, neLon: 180 },
    { swLat: -45, swLon: -180, neLat: 45.01, neLon: 180 },
  ]) {
    const result = await read(options);
    assert.equal(result.source, 'none');
    assert.deepEqual(result.positions, []);
    assert.equal(calls.length, 0);
  }
});
for (const [name, bbox] of [
  ['exactly 36 areas', { swLat: -45, swLon: -180, neLat: 45, neLon: 180 }],
  ['wrapped longitude', { swLat: 10, swLon: 170, neLat: 20, neLon: -170 }],
  ['MapLibre unwrapped longitude', { swLat: 10, swLon: 170, neLat: 20, neLon: 190 }],
  ['projection latitude overshoot', { swLat: 85, swLon: 10, neLat: 91, neLon: 20 }],
] as const) test(`${name} retains current Wingbits map semantics`, async () => {
  assert.equal((await read(bbox)).source, 'wingbits');
  assert.equal(providers().length, 1);
});

test('gateway answers 200 empty for a viewport just above the relay area limit without provider work', async () => {
  const response = await gateway(request({ sw_lat: '-45', sw_lon: '-180', ne_lat: '45.01', ne_lon: '180' }));
  // 200, not 422: the client track breaker opens after two failures and
  // would blank the flights layer after a zoom-out.
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.source, 'none');
  assert.deepEqual(body.positions ?? [], []);
  assert.equal(providers().length, 0);
  assert.ok(![...redis.redis.keys()].some(key => key.startsWith('aviation:track:')));
});
test('identifier lookup with an oversized viewport skips only the bbox tier', async () => {
  const result = await read({ swLat: -90, swLon: -180, neLat: 90, neLon: 180, icao24: 'abc123' });
  assert.deepEqual(providers().map(url => url.pathname), ['/opensky/states/all']);
  assert.equal(providers()[0]!.searchParams.get('icao24'), 'abc123');
  assert.notEqual(result.source, 'wingbits');
});
for (const status of [408, 429, 503]) test(`Wingbits ${status} outage retains display fallback`, async () => {
  wingbitsStatus = status;
  assert.equal((await read({ swLat: 24, swLon: 54, neLat: 26, neLon: 56 })).source, 'opensky');
  assert.deepEqual(providers().map(url => url.pathname), ['/wingbits/track', '/opensky/states/all']);
});

test('client track breaker stays closed across repeated zoom-outs past the relay area limit', async () => {
  const harnessFetch = globalThis.fetch;
  let gatewayCalls = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'https://www.worldmonitor.app');
    if (url.pathname !== PATH) return harnessFetch(input, init);
    gatewayCalls++;
    return gateway(new Request(`https://api.worldmonitor.app${PATH}${url.search}`, { headers: { 'X-WorldMonitor-Key': session, 'x-real-ip': '192.0.2.10' } }));
  }) as typeof fetch;
  const { fetchAircraftPositions } = await import('../src/services/aviation/index.ts');
  // Distinct viewports so the client's 15s result cache never answers. The
  // breaker opens after two failures, so a third request that still reaches
  // the gateway proves none of them counted as a failure.
  for (const neLat of [60, 70, 80]) {
    assert.deepEqual(await fetchAircraftPositions({ swLat: -60, swLon: -180, neLat, neLon: 180 }), []);
  }
  assert.equal(gatewayCalls, 3);
  assert.equal(providers().length, 0);
});
