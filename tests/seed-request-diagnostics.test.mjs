import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ingestCslEntries } from '../scripts/_csl-sanctions.mjs';

test('CSL preserves a safe nested transport code without exposing error text', async () => {
  const records = [];
  const warn = console.warn;
  console.warn = line => records.push(JSON.parse(line));
  try {
    const result = await ingestCslEntries({ fetchFn: async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('secret-url?token=private'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
    } });
    assert.equal(result.error, 'fetch failed (cause: UND_ERR_CONNECT_TIMEOUT)');
    assert.equal(records.length, 1);
    assert.equal(records[0].source, 'csl');
    assert.equal(records[0].errorCode, 'UND_ERR_CONNECT_TIMEOUT');
    assert.ok(!JSON.stringify(records).includes('private'));
  } finally { console.warn = warn; }
});
