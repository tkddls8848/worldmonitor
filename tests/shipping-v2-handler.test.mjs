/**
 * Functional tests for ShippingV2Service handlers. Tests the typed handlers
 * directly (not the HTTP gateway):
 *   - routeIntelligence: iso2 regex, hs2 non-digit stripping, cargoType
 *     coercion to legal enum, wire-shape byte-for-byte with partner contract
 *     (camelCase field names, ISO-8601 fetchedAt).
 *   - registerWebhook / listWebhooks: retired in the personal fork (the
 *     webhook subsystem was removed); both answer 410 Gone.
 */

import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach } from 'node:test';

const originalFetch = globalThis.fetch;
const originalEnv = { ...process.env };

function makeCtx(headers = {}) {
  const req = new Request('https://worldmonitor.app/api/v2/shipping/route-intelligence', {
    method: 'GET',
    headers,
  });
  return { request: req, pathParams: {}, headers };
}

function proCtx() {
  return makeCtx({ 'X-WorldMonitor-Key': 'pro-test-key' });
}

let routeIntelligence;
let shippingV2Handler;
let ValidationError;
let ApiError;

function stubChokepointStatus(value) {
  globalThis.fetch = async () => new Response(JSON.stringify({
    result: value == null ? null : JSON.stringify(value),
  }), { status: 200 });
}

describe('ShippingV2Service handlers', () => {
  beforeEach(async () => {
    process.env.WORLDMONITOR_VALID_KEYS = 'pro-test-key';
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';

    const riMod = await import('../server/worldmonitor/shipping/v2/route-intelligence.ts');
    routeIntelligence = riMod.routeIntelligence;
    ({ shippingV2Handler } = await import('../server/worldmonitor/shipping/v2/handler.ts'));
    const gen = await import('../src/generated/server/worldmonitor/shipping/v2/service_server.ts');
    ValidationError = gen.ValidationError;
    ApiError = gen.ApiError;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    Object.keys(process.env).forEach((k) => {
      if (!(k in originalEnv)) delete process.env[k];
    });
    Object.assign(process.env, originalEnv);
  });

  describe('routeIntelligence', () => {

    it('rejects malformed fromIso2 with ValidationError', async () => {
      // Stub redis GET for CHOKEPOINT_STATUS_KEY so the handler never panics.
      stubChokepointStatus(null);
      // 'usa' uppercases to 'USA' (3 chars) — regex `^[A-Z]{2}$` rejects.
      await assert.rejects(
        () => routeIntelligence(proCtx(), { fromIso2: 'usa', toIso2: 'NL', cargoType: '', hs2: '' }),
        (err) => err instanceof ValidationError && err.violations[0].field === 'fromIso2',
      );
    });

    it('preserves partner wire shape with ISO-8601 fetchedAt and camelCase fields', async () => {
      stubChokepointStatus({
        chokepoints: [{ id: 'suez', disruptionScore: 12, warRiskTier: 'WAR_RISK_TIER_ELEVATED' }],
        upstreamUnavailable: false,
      });
      const before = Date.now();
      const res = await routeIntelligence(proCtx(), {
        fromIso2: 'AE',
        toIso2: 'NL',
        cargoType: 'tanker',
        hs2: '27',
      });
      const after = Date.now();

      // Partner-visible top-level fields — exact names, camelCase, full set.
      assert.deepEqual(new Set(Object.keys(res)).size, 10);
      assert.equal(res.fromIso2, 'AE');
      assert.equal(res.toIso2, 'NL');
      assert.equal(res.cargoType, 'tanker');
      assert.equal(res.hs2, '27');
      assert.equal(typeof res.primaryRouteId, 'string');
      assert.ok(Array.isArray(res.chokepointExposures));
      assert.ok(Array.isArray(res.bypassOptions));
      assert.match(res.warRiskTier, /^WAR_RISK_TIER_/);
      assert.equal(typeof res.disruptionScore, 'number');

      // fetchedAt must be ISO-8601, NOT epoch ms — partners parse this string directly.
      assert.match(res.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
      const parsedTs = Date.parse(res.fetchedAt);
      assert.ok(parsedTs >= before && parsedTs <= after, 'fetchedAt within request window');
    });

    it('marks the route snapshot degraded when chokepoint status is unavailable', async () => {
      stubChokepointStatus(null);
      const res = await routeIntelligence(proCtx(), {
        fromIso2: 'AE',
        toIso2: 'NL',
        cargoType: 'tanker',
        hs2: '27',
      });

      assert.notEqual(res.primaryRouteId, '', 'static route lookup still found a route');
      assert.equal(res.fetchedAt, '', 'fetchedAt follows the upstream status miss');
    });

    it('does not mark a no-route country pair degraded when chokepoint status is available', async () => {
      stubChokepointStatus({
        chokepoints: [{ id: 'suez', disruptionScore: 12, warRiskTier: 'WAR_RISK_TIER_ELEVATED' }],
        upstreamUnavailable: false,
      });
      const res = await routeIntelligence(proCtx(), {
        fromIso2: 'ZZ',
        toIso2: 'NL',
        cargoType: 'tanker',
        hs2: '27',
      });

      assert.equal(res.primaryRouteId, '');
      assert.match(res.fetchedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/);
    });

    it('defaults hs2 to "27" when blank or all non-digits', async () => {
      stubChokepointStatus({
        chokepoints: [{ id: 'suez', disruptionScore: 12, warRiskTier: 'WAR_RISK_TIER_ELEVATED' }],
        upstreamUnavailable: false,
      });
      const res1 = await routeIntelligence(proCtx(), { fromIso2: 'AE', toIso2: 'NL', cargoType: '', hs2: '' });
      const res2 = await routeIntelligence(proCtx(), { fromIso2: 'AE', toIso2: 'NL', cargoType: '', hs2: 'abc' });
      assert.equal(res1.hs2, '27');
      assert.equal(res2.hs2, '27');
    });

    it('coerces unknown cargoType to container', async () => {
      stubChokepointStatus({
        chokepoints: [{ id: 'suez', disruptionScore: 12, warRiskTier: 'WAR_RISK_TIER_ELEVATED' }],
        upstreamUnavailable: false,
      });
      const res = await routeIntelligence(proCtx(), {
        fromIso2: 'AE',
        toIso2: 'NL',
        cargoType: 'spaceship',
        hs2: '',
      });
      assert.equal(res.cargoType, 'container');
    });
  });

  describe('webhooks (retired)', () => {
    for (const method of ['registerWebhook', 'listWebhooks']) {
      it(`${method} answers 410 Gone`, async () => {
        await assert.rejects(
          () => shippingV2Handler[method](proCtx(), {}),
          (err) => err instanceof ApiError && err.statusCode === 410,
        );
      });
    }
  });
});
