// @vitest-environment node
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('../_shared/redis', async (original) => ({
  ...await original<typeof import('../_shared/redis')>(),
  getCachedJson: vi.fn(),
  runRedisPipeline: vi.fn(async () => [{ result: 'OK' }]),
}));

import { createDomainGateway } from '../gateway';
import { getCachedJson } from '../_shared/redis';
import { getTheaterPosture } from '../worldmonitor/military/v1/get-theater-posture';
import { createMilitaryServiceRoutes, type MilitaryServiceHandler } from '../../src/generated/server/worldmonitor/military/v1/service_server';
import { getCountrySignalObservations } from '../worldmonitor/intelligence/v1/get-country-signal-observations';
import { createIntelligenceServiceRoutes, type IntelligenceServiceHandler } from '../../src/generated/server/worldmonitor/intelligence/v1/service_server';

const path = '/api/military/v1/get-theater-posture';
const url = `https://worldmonitor.app${path}`;
const gateway = createDomainGateway(createMilitaryServiceRoutes({ getTheaterPosture } as MilitaryServiceHandler).filter(r => r.path === path));
const posture = { provider: 'opensky', theaters: [{ theaterId: 'test', theaterName: 'Synthetic posture' }] };
const read = (headers: HeadersInit) => gateway(new Request(url, { headers }), { waitUntil: () => {} });

beforeEach(() => {
  vi.stubEnv('WORLDMONITOR_VALID_KEYS', 'enterprise-test');
  vi.stubEnv('LOCAL_API_MODE', '');
  vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.invalid');
  vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'synthetic');
  vi.mocked(getCachedJson).mockResolvedValue(posture);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

test('redistributable data remains available to the secondary enterprise key', async () => {
  vi.mocked(getCachedJson).mockResolvedValue({ ...posture, provider: 'wingbits' });
  const response = await read({ 'X-WorldMonitor-Key': '', 'X-Api-Key': 'enterprise-test' });
  expect(response.status).toBe(200);
  expect((await response.json()).theaters).toHaveLength(1);
});
test.each(['header', 'cookie'])('browser %s session retains display data', async (kind) => {
  const token = 'wms_test-browser-session';
  const headers = kind === 'header' ? { 'X-WorldMonitor-Key': '', 'X-Api-Key': token } : { Cookie: `wm-session=${token}` };
  const response = await read(headers);
  expect(response.status).toBe(200);
  expect((await response.json()).theaters).toHaveLength(1);
});
test('nonempty primary retains priority over a secondary enterprise key', async () => {
  const token = 'wms_test-browser-session';
  const response = await read({ 'X-WorldMonitor-Key': token, 'X-Api-Key': 'enterprise-test' });
  expect(response.status).toBe(200);
  expect((await response.json()).theaters).toHaveLength(1);
});

const countryPath = '/api/intelligence/v1/get-country-signal-observations';
const countryUrl = `https://worldmonitor.app${countryPath}?country_code=IR&family=COUNTRY_SIGNAL_FAMILY_POSTURE`;
const countryGateway = createDomainGateway(createIntelligenceServiceRoutes({ getCountrySignalObservations } as IntelligenceServiceHandler).filter(route => route.path === countryPath));
const readCountry = (headers: HeadersInit = {}) => countryGateway(new Request(countryUrl, { headers }), { waitUntil: () => {} });


test.each(['header', 'cookie'])('country projection preserves qualified observations for an ordinary %s session', async kind => {
  vi.mocked(getCachedJson).mockResolvedValue({ provider: 'adsb.lol', theaters: [{ theater: 'iran-theater', postureLevel: 'critical', activeFlights: 10, assessedAt: 1792324800000 }] });
  const token = 'wms_test-browser-session';
  const response = await readCountry(kind === 'header' ? { 'X-WorldMonitor-Key': token } : { Cookie: `wm-session=${token}` });
  expect(response.status).toBe(200);
  expect(response.headers.get('Cache-Control')).toBe('no-store');
  const outcome = JSON.parse((await response.json()).outcomeJson);
  expect(outcome).toMatchObject({ countryCode: 'IR', family: 'posture', state: 'observed' });
  expect(outcome.observations).toMatchObject([{ title: '10 military aircraft in iran-theater', source: 'adsb.lol', severity: 'high' }]);
});
