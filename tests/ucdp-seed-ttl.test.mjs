import test from 'node:test';
import assert from 'node:assert/strict';
import { extendExistingTtl } from '../scripts/seed-ucdp-events.mjs';

test('failed UCDP refresh does not claim a missing key was kept alive', async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalWarn = console.warn;
  const warnings = [];
  const logs = [];
  globalThis.fetch = async (_url, init) => {
    const [, key] = JSON.parse(init.body);
    return Response.json({ result: key === 'conflict:ucdp-events:v1' ? 0 : 1 });
  };
  console.log = (...args) => logs.push(args.join(' '));
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    assert.equal(await extendExistingTtl('https://redis.invalid', 'test-token'), false);
    assert.ok(warnings.some((line) => line.includes('conflict:ucdp-events:v1 was a no-op')));
    assert.ok(!logs.some((line) => line.includes('Extended TTL')));
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.warn = originalWarn;
  }
});
