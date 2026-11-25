// Personal fork: the loopback ingress and local API handle access.
// The gateway routes; it neither authenticates, meters nor rate-limits. A
// premium RPC called with no cookie, Authorization or API key header must run
// its handler and return 200 (Review Focus 1).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';

const ENV_KEYS = [
  'UPSTASH_REDIS_REST_URL',
  'UPSTASH_REDIS_REST_TOKEN',
  'WORLDMONITOR_VALID_KEYS',
  'WM_SESSION_SECRET',
  'LOCAL_API_MODE',
] as const;
const savedEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const originalFetch = globalThis.fetch;
let externalFetches = 0;

before(() => {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  // Any network call (Redis limiter, Convex entitlement, Clerk JWKS) would be
  // a gate the personal gateway no longer has.
  globalThis.fetch = (async () => {
    externalFetches += 1;
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function makeGateway() {
  const calls: Record<string, number> = {};
  const handler = (name: string) => async () => {
    calls[name] = (calls[name] ?? 0) + 1;
    return new Response(JSON.stringify({ ok: true, name }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const gateway = createDomainGateway([
    { method: 'GET', path: '/api/supply-chain/v1/get-country-cost-shock', handler: handler('cost-shock') },
    { method: 'POST', path: '/api/scenario/v1/run-scenario', handler: handler('run-scenario') },
  ]);
  return { gateway, calls };
}

function bareRequest(path: string, method = 'GET'): Request {
  // Deliberately no Cookie, Authorization, X-WorldMonitor-Key or X-Api-Key.
  return new Request(`http://127.0.0.1:3000${path}`, {
    method,
    ...(method === 'POST'
      ? { body: JSON.stringify({ scenarioId: 'hormuz-tanker-blockade' }), headers: { 'Content-Type': 'application/json' } }
      : {}),
  });
}

describe('personal gateway', () => {
  it('premium RPC runs its handler without credentials', async () => {
    const { gateway, calls } = makeGateway();

    const shock = await gateway(bareRequest('/api/supply-chain/v1/get-country-cost-shock?iso2=KR&chokepoint_id=hormuz_strait'));
    assert.equal(shock.status, 200, await shock.clone().text());
    assert.deepEqual(await shock.json(), { ok: true, name: 'cost-shock' });
    assert.equal(calls['cost-shock'], 1);

    const scenario = await gateway(bareRequest('/api/scenario/v1/run-scenario', 'POST'));
    assert.equal(scenario.status, 200, await scenario.clone().text());
    assert.deepEqual(await scenario.json(), { ok: true, name: 'run-scenario' });
    assert.equal(calls['run-scenario'], 1);
  });

  it('no rate limit after many calls', async () => {
    const { gateway, calls } = makeGateway();
    const statuses = new Set<number>();
    for (let i = 0; i < 200; i += 1) {
      const res = await gateway(bareRequest('/api/supply-chain/v1/get-country-cost-shock?iso2=KR'));
      statuses.add(res.status);
      await res.arrayBuffer();
    }
    assert.deepEqual([...statuses], [200]);
    assert.equal(calls['cost-shock'], 200);
    assert.equal(externalFetches, 0, 'the gateway must not call Redis, Convex or Clerk');
  });

  it('unknown route is 404', async () => {
    const { gateway, calls } = makeGateway();
    const res = await gateway(bareRequest('/api/supply-chain/v1/no-such-rpc'));
    assert.equal(res.status, 404);
    assert.deepEqual(calls, {});
  });
});
