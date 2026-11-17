import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostCountryDownload, CountryDownloadRequestError, COUNTRY_EXPORT_TEXT_BYTES } from '../src/utils/country-text-download';

const capability = { protocolVersion: '2026-01-26', hostCapabilities: { downloadFile: {} } };
const artifact = { filename: 'country-evidence-CA-2026-10-06.md', mimeType: 'text/markdown;charset=utf-8' as const, content: 'Canada\nSource: USGS\nObservation: unknown\nRetained: 2026-10-06T05:57:35Z\n' };
test('absent, malformed and incompatible capability sends no speculative host request', async () => {
  let calls = 0;
  for (const initialized of [undefined, null, [], {}, { protocolVersion: '2026-01-26' }, { ...capability, protocolVersion: 'other' }, ...[null, true, [], 'yes', 1].map(downloadFile => ({ ...capability, hostCapabilities: { downloadFile } }))]) {
    const deliver = createHostCountryDownload(() => initialized, async () => { calls++; return {}; });
    assert.deepEqual(await deliver(artifact, new AbortController().signal), { state: 'unsupported' });
  }
  assert.equal(calls, 0);
});
test('advertised inline text preserves filename, MIME, provenance and exact snapshot bytes', async () => {
  const calls: unknown[] = [];
  const deliver = createHostCountryDownload(() => capability, async (method, params) => { calls.push({ method, params }); return {}; });
  assert.deepEqual(await deliver(artifact, new AbortController().signal), { state: 'host-accepted' });
  assert.deepEqual(calls, [{ method: 'ui/download-file', params: { contents: [{ type: 'resource', resource: { uri: `file:///${artifact.filename}`, mimeType: artifact.mimeType, text: artifact.content } }] } }]);
  assert.equal(/receipt|token|arguments|resource_link/.test(JSON.stringify(calls)), false);
});
test('returned denial, malformed result, RPC error, timeout and closure have truthful outcomes without retries', async () => {
  for (const [value, state] of [[{}, 'host-accepted'], [{ isError: false }, 'host-accepted'], [{ isError: true }, 'error'], [undefined, 'unconfirmed'], [null, 'unconfirmed'], [[], 'unconfirmed'], [{ isError: 'false' }, 'unconfirmed'], [true, 'unconfirmed']] as const) {
    let calls = 0;
    const deliver = createHostCountryDownload(() => capability, async () => { calls++; return value; });
    assert.deepEqual(await deliver(artifact, new AbortController().signal), { state }); assert.equal(calls, 1);
  }
  for (const [kind, state] of [['rpc', 'error'], ['timeout', 'unconfirmed'], ['closed', 'unconfirmed']] as const) {
    let calls = 0;
    const deliver = createHostCountryDownload(() => capability, async () => { calls++; throw new CountryDownloadRequestError(kind); });
    assert.deepEqual(await deliver(artifact, new AbortController().signal), { state }); assert.equal(calls, 1);
  }
});
test('cancellation before send and while waiting never becomes accepted', async () => {
  const controller = new AbortController(); let calls = 0;
  const deliver = createHostCountryDownload(() => capability, async () => { calls++; controller.abort(); return {}; });
  assert.deepEqual(await deliver(artifact, controller.signal), { state: 'unconfirmed' }); assert.equal(calls, 1);
  assert.deepEqual(await deliver(artifact, controller.signal), { state: 'unconfirmed' }); assert.equal(calls, 1);
});
test('bounds UTF8 artifact and serialized request separately, without truncation or a host call', async () => {
  let calls = 0;
  const deliver = createHostCountryDownload(() => capability, async () => { calls++; return {}; });
  for (const changed of [{ ...artifact, filename: '../private.md' }, { ...artifact, content: '\uD800' }, { ...artifact, content: 'é'.repeat(COUNTRY_EXPORT_TEXT_BYTES / 2 + 1) }, { ...artifact, content: '\u0000'.repeat(COUNTRY_EXPORT_TEXT_BYTES / 2) }]) {
    assert.deepEqual(await deliver(changed, new AbortController().signal), { state: 'error' });
  }
  assert.equal(calls, 0);
  assert.deepEqual(await deliver({ ...artifact, content: 'a'.repeat(COUNTRY_EXPORT_TEXT_BYTES) }, new AbortController().signal), { state: 'host-accepted' });
});
