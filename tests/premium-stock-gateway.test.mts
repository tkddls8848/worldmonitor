import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, it, before, after, mock } from 'node:test';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

import { createDomainGateway } from '../server/gateway.ts';
import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';
import { issueSessionToken } from '../api/_session.js';
import { createRedisFetch } from './helpers/fake-upstash-redis.mts';

// User API keys must be canonical `wm_` + 40 lowercase hex — that is the only
// shape generateKey() (src/services/api-keys.ts) ever mints, and since #5379
// validateUserApiKey rejects anything else BEFORE hashing so a malformed key
// cannot burn a SHA-256 + Redis + Convex round-trip. These fixtures previously
// used readable placeholders ('wm_free_test_key') that production could never
// produce, so they exercised the gateway with an impossible input. The Convex
// mocks below match on URL, not on the key or its hash, so the values here are
// arbitrary as long as they are well-shaped.
const FREE_USER_KEY = `wm_${'a'.repeat(40)}`;
const PRO_USER_KEY = `wm_${'b'.repeat(40)}`;
const OWNER_PRO_USER_KEY = `wm_${'c'.repeat(40)}`;

const originalKeys = process.env.WORLDMONITOR_VALID_KEYS;
const originalSessionSecret = process.env.WM_SESSION_SECRET;
const originalRedisUrl = process.env.UPSTASH_REDIS_REST_URL;
const originalRedisToken = process.env.UPSTASH_REDIS_REST_TOKEN;
const originalFetch = globalThis.fetch;

function installRateLimitRedisFake(): void {
  process.env.UPSTASH_REDIS_REST_URL = 'https://redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'token';
  const { fetchImpl } = createRedisFetch({});
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (url.startsWith(process.env.UPSTASH_REDIS_REST_URL || '')) {
      return fetchImpl(input, init);
    }
    return originalFetch(input, init);
  }) as typeof fetch;
}

const ISSUE_4609_GATED_ROUTES = [
  { method: 'GET', path: '/api/market/v1/get-insider-transactions' },
  { method: 'POST', path: '/api/forecast/v1/trigger-simulation' },
  { method: 'POST', path: '/api/scenario/v1/run-scenario' },
  { method: 'GET', path: '/api/scenario/v1/get-scenario-status' },
  { method: 'GET', path: '/api/supply-chain/v1/get-country-chokepoint-index' },
  { method: 'GET', path: '/api/supply-chain/v1/get-bypass-options' },
  { method: 'GET', path: '/api/supply-chain/v1/get-country-cost-shock' },
  { method: 'GET', path: '/api/supply-chain/v1/get-route-explorer-lane' },
  { method: 'GET', path: '/api/supply-chain/v1/get-route-impact' },
  { method: 'GET', path: '/api/supply-chain/v1/get-country-products' },
  { method: 'GET', path: '/api/supply-chain/v1/get-multi-sector-cost-shock' },
  { method: 'GET', path: '/api/supply-chain/v1/get-sector-dependency' },
  { method: 'GET', path: '/api/trade/v1/list-comtrade-flows' },
  { method: 'GET', path: '/api/trade/v1/get-tariff-trends' },
  { method: 'GET', path: '/api/market/v1/analyze-stock' },
  { method: 'GET', path: '/api/market/v1/get-stock-analysis-history' },
  { method: 'GET', path: '/api/market/v1/backtest-stock' },
  { method: 'GET', path: '/api/market/v1/list-stored-stock-backtests' },
] as const;

// Public routes now require a wms_ session token (issue #3541) — header-only
// origin trust is gone. Mint one for tests that previously relied on
// "trusted browser origin = anonymous public read."
process.env.WM_SESSION_SECRET = originalSessionSecret
  ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
let SESSION_TOKEN: string;
before(async () => {
  installRateLimitRedisFake();
  SESSION_TOKEN = (await issueSessionToken()).token;
});

after(() => {
  globalThis.fetch = originalFetch;
  if (originalRedisUrl == null) delete process.env.UPSTASH_REDIS_REST_URL;
  else process.env.UPSTASH_REDIS_REST_URL = originalRedisUrl;
  if (originalRedisToken == null) delete process.env.UPSTASH_REDIS_REST_TOKEN;
  else process.env.UPSTASH_REDIS_REST_TOKEN = originalRedisToken;
});

afterEach(() => {
  if (originalKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
  else process.env.WORLDMONITOR_VALID_KEYS = originalKeys;
  installRateLimitRedisFake();
  // Keep the session secret stable across tests so SESSION_TOKEN stays valid.
  process.env.WM_SESSION_SECRET = originalSessionSecret
    ?? 'test-secret-must-be-at-least-32-chars-long-xxx';
});

describe('premium gateway API key enforcement', () => {


  it('allows issue #4609 Pro RPCs for tier-1 entitlements', async () => {
    const handler = createDomainGateway(ISSUE_4609_GATED_ROUTES.map(({ method, path }) => ({
      method,
      path,
      handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })));

    const originalSiteUrl = process.env.CONVEX_SITE_URL;
    const originalSecret = process.env.CONVEX_SERVER_SHARED_SECRET;
    const originalFetchForIssue4609ProTest = globalThis.fetch;
    process.env.CONVEX_SITE_URL = 'https://test.convex.site';
    process.env.CONVEX_SERVER_SHARED_SECRET = 'test-secret';

    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url.endsWith('/api/internal-validate-api-key')) {
        return new Response(
          JSON.stringify({ id: 'pro-key', userId: 'pro_api_user', name: 'Pro API key', keyKind: 'api' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      if (url.endsWith('/api/internal-entitlements')) {
        return new Response(
          JSON.stringify({
            planKey: 'pro_monthly',
            validUntil: Date.now() + 86_400_000,
            features: {
              tier: 1,
              apiAccess: true,
              apiRateLimit: 60,
              maxDashboards: 10,
              prioritySupport: false,
              exportFormats: ['csv'],
              mcpAccess: true,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return originalFetchForIssue4609ProTest(input, init);
    }) as typeof fetch;

    try {
      for (const { method, path } of ISSUE_4609_GATED_ROUTES) {
        const res = await handler(new Request(`https://worldmonitor.app${path}`, {
          method,
          headers: {
            Origin: 'https://worldmonitor.app',
            'X-Api-Key': PRO_USER_KEY,
          },
        }));
        assert.equal(res.status, 200, `${method} ${path} should allow tier-1 Pro entitlements`);
        assert.deepEqual(await res.json(), { ok: true });
      }
    } finally {
      globalThis.fetch = originalFetchForIssue4609ProTest;
      if (originalSiteUrl === undefined) delete process.env.CONVEX_SITE_URL;
      else process.env.CONVEX_SITE_URL = originalSiteUrl;
      if (originalSecret === undefined) delete process.env.CONVEX_SERVER_SHARED_SECRET;
      else process.env.CONVEX_SERVER_SHARED_SECRET = originalSecret;
    }
  });


  it('serves the freed national-debt and sanctions-pressure routes to an anonymous wms_ session', async () => {
    // Both seeds are already public through /api/bootstrap?tier=slow&public=1,
    // so the gateway must not re-gate the RPCs behind Pro auth or a tier.
    const freedPaths = [
      '/api/economic/v1/get-national-debt',
      '/api/sanctions/v1/list-sanctions-pressure',
    ];
    const handler = createDomainGateway(freedPaths.map((path) => ({
      method: 'GET',
      path,
      handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    })));

    for (const path of freedPaths) {
      const res = await handler(new Request(`https://worldmonitor.app${path}`, {
        headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
      }));
      assert.equal(res.status, 200, `wms_ session must reach ${path} (got ${res.status})`);
    }
  });


});

describe('POST-to-GET compatibility hardening', () => {
  async function captureRedisCalls(run: () => Promise<Response>) {
    const delegateFetch = globalThis.fetch;
    const redisCalls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (url.startsWith(process.env.UPSTASH_REDIS_REST_URL || '')) {
        redisCalls.push({
          url,
          body: typeof init?.body === 'string' ? init.body : '',
        });
      }
      return delegateFetch(input, init);
    }) as typeof fetch;
    try {
      return { response: await run(), redisCalls };
    } finally {
      globalThis.fetch = delegateFetch;
    }
  }

  function makePublicMarketHandler() {
    let seenUrl: URL | null = null;
    const handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async (req) => {
          seenUrl = new URL(req.url);
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      },
    ]);
    return {
      handler,
      seenUrl: () => seenUrl,
    };
  }

  function compatPost(body: string, headers: Record<string, string> = {}) {
    return new Request('https://worldmonitor.app/api/market/v1/list-market-quotes', {
      method: 'POST',
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': SESSION_TOKEN,
        'Content-Type': 'application/json',
        ...headers,
      },
      body,
    });
  }

  it('converts bounded scalar and array JSON bodies to GET query params', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({ symbols: ['AAPL', 'MSFT'], includeExtended: true });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 200);
    assert.deepEqual(seenUrl()?.searchParams.getAll('symbols'), ['AAPL', 'MSFT']);
    assert.equal(seenUrl()?.searchParams.get('includeExtended'), 'true');
  });

  it('rejects POST-to-GET array expansion over 200 values', async () => {
    const { handler } = makePublicMarketHandler();
    const body = JSON.stringify({
      symbols: Array.from({ length: 201 }, (_, i) => `SYM${i}`),
    });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'Too many values for POST compatibility parameter',
      parameter: 'symbols',
      maxValues: 200,
    });
  });

  it('skips POST-to-GET compatibility before reading bodies with missing, invalid, or oversized Content-Length', async () => {
    const { handler } = makePublicMarketHandler();
    const body = JSON.stringify({ symbols: ['AAPL'] });

    const missingReq = compatPost(body);
    missingReq.clone = () => { throw new Error('POST compatibility must not parse missing-length bodies'); };
    const missing = await handler(missingReq);
    assert.equal(missing.status, 405);

    const invalidReq = compatPost(body, { 'Content-Length': 'abc' });
    invalidReq.clone = () => { throw new Error('POST compatibility must not parse invalid-length bodies'); };
    const invalid = await handler(invalidReq);
    assert.equal(invalid.status, 405);

    const oversizedReq = compatPost(body, { 'Content-Length': '1048576' });
    oversizedReq.clone = () => { throw new Error('POST compatibility must not parse oversized bodies'); };
    const oversized = await handler(oversizedReq);
    assert.equal(oversized.status, 405);
  });

  it('rejects malformed JSON instead of falling back to an unfiltered GET', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = '{not json';

    const { response: res, redisCalls } = await captureRedisCalls(
      () => handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) })),
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Invalid JSON body for POST compatibility' });
    assert.equal(seenUrl(), null);
  });

  it('rejects a JSON array body instead of encoding index keys as query params', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify(['AAPL', 'MSFT']);

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Unsupported POST compatibility body' });
    assert.equal(seenUrl(), null);
  });

  it('rejects object values without applying sibling scalars', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({
      symbols: ['AAPL'],
      filter: { sector: 'tech' },
    });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'Unsupported value for POST compatibility parameter',
      parameter: 'filter',
    });
    assert.equal(seenUrl(), null);
  });

  it('rejects non-scalar array members without applying sibling scalars', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({
      includeExtended: true,
      symbols: ['AAPL', { nested: true }],
    });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'Unsupported value for POST compatibility parameter',
      parameter: 'symbols',
    });
    assert.equal(seenUrl(), null);
  });

  it('rejects null values without applying sibling scalars', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({
      includeExtended: true,
      symbols: null,
    });

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      error: 'Unsupported value for POST compatibility parameter',
      parameter: 'symbols',
    });
    assert.equal(seenUrl(), null);
  });

  it('converts empty POST bodies to GET without query params', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();

    const res = await handler(compatPost('', { 'Content-Length': '0' }));

    assert.equal(res.status, 200);
    assert.equal(seenUrl()?.search, '');
  });

  it('converts whitespace-only POST bodies to GET without query params', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = ' \n\t ';

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 200);
    assert.equal(seenUrl()?.search, '');
  });

  it('rejects a JSON null body', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = 'null';

    const res = await handler(compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'Unsupported POST compatibility body' });
    assert.equal(seenUrl(), null);
  });

  it('does not reject an unsupported body when no GET fallback route exists', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({ filter: { nested: true } });

    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/does-not-exist', {
      method: 'POST',
      headers: {
        Origin: 'https://worldmonitor.app',
        'X-WorldMonitor-Key': SESSION_TOKEN,
        'Content-Type': 'application/json',
        'Content-Length': String(Buffer.byteLength(body)),
      },
      body,
    }));

    assert.equal(res.status, 404);
    assert.equal(seenUrl(), null);
  });

  it('returns 400 when the POST compatibility body cannot be read', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({ symbols: ['AAPL'] });
    const req = compatPost(body, { 'Content-Length': String(Buffer.byteLength(body)) });
    req.clone = () => ({
      text: async () => {
        throw new Error('stream reset');
      },
    }) as Request;

    const { response: res, redisCalls } = await captureRedisCalls(() => handler(req));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'malformed_request' });
    assert.equal(seenUrl(), null);
  });

  it('enforces the actual-byte backstop when Content-Length understates a multibyte body', async () => {
    const { handler, seenUrl } = makePublicMarketHandler();
    const body = JSON.stringify({ symbols: ['é'.repeat(524_288)] });
    assert.ok(Buffer.byteLength(body) >= 1_048_576);

    const res = await handler(compatPost(body, { 'Content-Length': '128' }));

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), { error: 'malformed_request' });
    assert.equal(seenUrl(), null);
  });
});

// ---------------------------------------------------------------------------
// Bearer token auth path for premium endpoints
// ---------------------------------------------------------------------------

describe('premium gateway bearer token auth', () => {
  let privateKey: CryptoKey;
  let wrongPrivateKey: CryptoKey;
  let jwksServer: Server;
  let jwksPort: number;
  let handler: (req: Request) => Promise<Response>;

  before(async () => {
    const { publicKey, privateKey: pk } = await generateKeyPair('RS256');
    privateKey = pk;

    const { privateKey: wpk } = await generateKeyPair('RS256');
    wrongPrivateKey = wpk;

    const publicJwk = await exportJWK(publicKey);
    publicJwk.kid = 'test-key-1';
    publicJwk.alg = 'RS256';
    publicJwk.use = 'sig';
    const jwks = { keys: [publicJwk] };

    jwksServer = createServer((req, res) => {
      if (req.url === '/.well-known/jwks.json') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(jwks));
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    await new Promise<void>((resolve) => {
      jwksServer.listen(0, '127.0.0.1', () => resolve());
    });
    const addr = jwksServer.address();
    jwksPort = typeof addr === 'object' && addr ? addr.port : 0;

    process.env.CLERK_JWT_ISSUER_DOMAIN = `http://127.0.0.1:${jwksPort}`;
    process.env.WORLDMONITOR_VALID_KEYS = 'real-key-123';

    handler = createDomainGateway([
      {
        method: 'GET',
        path: '/api/market/v1/analyze-stock',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-score',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/resilience/v1/get-resilience-ranking',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
      {
        method: 'GET',
        path: '/api/market/v1/list-market-quotes',
        handler: async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
      },
    ]);
  });

  after(async () => {
    jwksServer?.close();
    delete process.env.CLERK_JWT_ISSUER_DOMAIN;
  });

  function signToken(claims: Record<string, unknown>, opts?: { key?: CryptoKey; audience?: string }) {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key-1' })
      .setIssuer(`http://127.0.0.1:${jwksPort}`)
      .setAudience(opts?.audience ?? 'convex')
      .setSubject(claims.sub as string ?? 'user_test')
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(opts?.key ?? privateKey);
  }


  it('valid Pro bearer token unlocks tier-1 entitlement-gated endpoints without a Convex row', async () => {
    // Clerk role='pro' remains a supported Pro signal for complimentary,
    // tester, and legacy grants that do not have a Convex entitlement row.
    const token = await signToken({ sub: 'user_pro', plan: 'pro' });
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/analyze-stock?symbol=AAPL', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  });



  // Every premium direct-LLM route must deny a confirmed free account. The
  // gateway treats a resolved Clerk session as authenticated on quota routes,
  // and deduct-situation (premium, quota-metered, but not tier-gated) used to
  // ride that through to the handler with a 200 for any free sign-in.



  it('public routes accept the anonymous browser session token', async () => {
    const res = await handler(new Request('https://worldmonitor.app/api/market/v1/list-market-quotes?symbols=AAPL', {
      headers: { Origin: 'https://worldmonitor.app', 'X-WorldMonitor-Key': SESSION_TOKEN },
    }));
    assert.equal(res.status, 200);
  });




  it('accepts valid Pro bearer token on resilience premium endpoints → 200', async () => {
    const token = await signToken({ sub: 'user_pro', plan: 'pro' });

    const scoreRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-score?countryCode=US', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(scoreRes.status, 200);

    const rankingRes = await handler(new Request('https://worldmonitor.app/api/resilience/v1/get-resilience-ranking', {
      headers: {
        Origin: 'https://worldmonitor.app',
        Authorization: `Bearer ${token}`,
      },
    }));
    assert.equal(rankingRes.status, 200);
  });


});
