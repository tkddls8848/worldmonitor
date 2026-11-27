import assert from 'node:assert/strict';
import { after, beforeEach, it } from 'node:test';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;
process.env.VERCEL_ENV = 'preview';
process.env.VERCEL_GIT_COMMIT_SHA = '123456789abcdef0';
process.env.UPSTASH_REDIS_REST_URL = 'https://seed-redis.invalid';
process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
delete process.env.LOCAL_API_MODE;

const { getKeyPrefix } = await import('../server/_shared/redis');
const { listPredictionMarkets } = await import('../server/worldmonitor/prediction/v1/list-prediction-markets');
const { getUSNIFleetReport } = await import('../server/worldmonitor/military/v1/get-usni-fleet-report');
const { getHumanitarianSummary } = await import('../server/worldmonitor/conflict/v1/get-humanitarian-summary');
const { getHumanitarianSummaryBatch } = await import('../server/worldmonitor/conflict/v1/get-humanitarian-summary-batch');

const cache = new Map<string, unknown>();
const commands: unknown[][] = [];
const market = { title: 'Will the event occur?', yesPrice: 60, volume: 100, url: 'https://example.test/event/one' };

beforeEach(() => {
  cache.clear();
  commands.length = 0;
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://seed-redis.invalid');
    if (url.pathname.startsWith('/get/')) {
      const key = decodeURIComponent(url.pathname.slice(5));
      commands.push(['GET', key]);
      return Response.json({ result: cache.has(key) ? JSON.stringify(cache.get(key)) : null });
    }
    const body = JSON.parse(String(init?.body));
    if (url.pathname === '/pipeline') {
      commands.push(...body);
      if (body.every((command: string[]) => command[0] === 'GET')) {
        return Response.json(body.map((command: string[]) => ({
          result: cache.has(command[1]) ? JSON.stringify(cache.get(command[1])) : null,
        })));
      }
      assert.fail('Unexpected Redis pipeline command');
    }
    assert.equal(body[0], 'SET');
    commands.push(body);
    cache.set(body[1], JSON.parse(body[2]));
    return Response.json({ result: 'OK' });
  };
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) if (!(key in originalEnv)) delete process.env[key];
  Object.assign(process.env, originalEnv);
});

it('runs with a deployment prefix', () => {
  assert.equal(getKeyPrefix(), 'preview:12345678:');
});

for (const [category, key, payload] of [
  ['politics', 'prediction:markets-bootstrap:v1', { geopolitical: [market], fetchedAt: 123 }],
  ['country:US', 'prediction:markets-country-index:v1', { countries: { US: [market] }, fetchedAt: 123 }],
] as const) {
  it(`serves seeded prediction ${category} from the canonical key`, async () => {
    cache.set(key, payload);
    const result = await listPredictionMarkets({} as never, { category, query: '', pageSize: 10, cursor: '' });
    assert.equal(result.dataAvailable, true);
    assert.equal(result.markets[0]?.title, market.title);
    assert.equal(result.fetchedAt, 123);
    assert.deepEqual(commands, [['GET', key]]);
  });
}

for (const stale of [false, true]) {
  it(`serves the ${stale ? 'stale' : 'primary'} USNI seed without a deployment prefix`, async () => {
    const report = { title: 'Fleet report', vessels: [], strikeGroups: [] };
    cache.set(stale ? 'usni-fleet:sebuf:stale:v1' : 'usni-fleet:sebuf:v1', report);
    const result = await getUSNIFleetReport({} as never, { forceRefresh: false });
    assert.deepEqual(result.report, report);
    assert.equal(result.cached, true);
    assert.equal(result.stale, stale);
    assert.deepEqual(commands, stale
      ? [['GET', 'usni-fleet:sebuf:v1'], ['GET', 'usni-fleet:sebuf:stale:v1']]
      : [['GET', 'usni-fleet:sebuf:v1']]);
  });
}

it('serves the canonical humanitarian seed without provider fallback', async () => {
  const payload = { summary: { countryCode: 'YE', countryName: 'Yemen', totalDisplaced: 123 } };
  cache.set('conflict:humanitarian:v1:YE', payload);
  assert.deepEqual(await getHumanitarianSummary({} as never, { countryCode: 'YE' }), payload);
  assert.deepEqual(commands, [['GET', 'conflict:humanitarian:v1:YE']]);
});

it('serves canonical humanitarian seeds through the batch RPC', async () => {
  const summary = { countryCode: 'YE', countryName: 'Yemen', totalDisplaced: 123 };
  cache.set('conflict:humanitarian:v1:YE', { summary });
  const result = await getHumanitarianSummaryBatch({} as never, { countryCodes: ['YE', 'SD', 'YE'] });
  assert.deepEqual(result, { results: { YE: summary }, fetched: 1, requested: 2 });
  assert.deepEqual(commands, [['GET', 'conflict:humanitarian:v1:SD'], ['GET', 'conflict:humanitarian:v1:YE']]);
});
