import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import oref from '../api/oref-alerts.js';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('OREF redirects noncanonical queries without relay or limiter work', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected I/O'); };
  for (const [query, canonical] of [
    ['?unused=anything', ''], ['?endpoint=unknown', ''],
    ['?endpoint=history&unused=x', '?endpoint=history'],
    ['?endpoint=history&endpoint=alerts', '?endpoint=history'],
  ]) {
    const response = await oref(new Request(`https://worldmonitor.app/api/oref-alerts${query}`));
    assert.equal(response.status, 308);
    assert.equal(response.headers.get('Location'), `https://worldmonitor.app/api/oref-alerts${canonical}`);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  }
  assert.equal(calls, 0);
});

test('OREF keeps origin and method checks ahead of canonical redirects', async () => {
  const url = 'https://worldmonitor.app/api/oref-alerts?unused=x';
  assert.equal((await oref(new Request(url, { headers: { Origin: 'https://evil.example' } }))).status, 403);
  assert.equal((await oref(new Request(url, { method: 'POST' }))).status, 405);
  assert.equal((await oref(new Request(url, { method: 'OPTIONS' }))).status, 204);
});

test('canonical OREF responses retain aggregation without a caller limiter', async () => {
  const saved = { ...process.env };
  process.env.WS_RELAY_URL = 'https://relay.example';
  process.env.UPSTASH_REDIS_REST_URL = 'https://oref-redis.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'synthetic';
  const relayPaths = [];
  let rateCalls = 0;
  globalThis.fetch = async (input) => {
    const url = new URL(String(input));
    if (url.hostname === 'oref-redis.example') {
      rateCalls++;
      return Response.json([{ result: [599, 600] }]);
    }
    relayPaths.push(url.pathname);
    return Response.json({ alerts: [] });
  };
  try {
    for (const suffix of ['', '?endpoint=history']) {
      const response = await oref(new Request(`https://worldmonitor.app/api/oref-alerts${suffix}`));
      assert.equal(response.status, 200);
      assert.match(response.headers.get('Cache-Control'), /^public,/);
    }
    assert.deepEqual(relayPaths, ['/oref/alerts', '/oref/history']);
    assert.equal(rateCalls, 0); // personal fork: no per-caller limiter
  } finally {
    for (const key of ['WS_RELAY_URL', 'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
  }
});
