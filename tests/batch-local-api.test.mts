/**
 * A batch sent to the personal server, end to end: Basic-auth ingress ->
 * local API (which requires its per-process transport token) -> the real
 * batch gateway -> each sub-operation back through the local API.
 *
 * The ingress strips the caller's Authorization and the local API strips the
 * transport token before any handler runs, so the batch handler has to send
 * the server's own token with each sub-request, and must never return it.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const LOCAL_TOKEN = 'batch-local-api-test-token-0123456789abcdef';
const PASSWORD = 'batch-test-password-123456';
// The local API replaces global fetch with an SSRF-guarded one that refuses
// loopback ports other than its own; the test talks to the ingress as an
// outside client would.
const clientFetch = globalThis.fetch;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A stand-in RPC that answers with the headers it was given, so a leaked
// token would show up in the batch result body.
const PROBE_HANDLER = `
export default async function handler(request) {
  const url = new URL(request.url);
  return new Response(JSON.stringify({ rpc: url.pathname, query: url.search, headers: Object.fromEntries(request.headers) }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
`;

describe('batch through the personal server', () => {
  let tempRoot = '';
  let base = '';
  let closeAll: () => Promise<void> = async () => {};
  const previousToken = process.env.LOCAL_API_TOKEN;

  before(async () => {
    process.env.LOCAL_API_TOKEN = LOCAL_TOKEN;
    tempRoot = await mkdtemp(path.join(os.tmpdir(), 'wm-batch-local-'));
    const apiDir = path.join(tempRoot, 'api');
    const distDir = path.join(tempRoot, 'dist');
    await mkdir(path.join(apiDir, 'batch', 'v1'), { recursive: true });
    await mkdir(path.join(apiDir, 'probe', 'v1'), { recursive: true });
    await mkdir(distDir, { recursive: true });
    await writeFile(path.join(distDir, 'dashboard.html'), '<html></html>');
    const gateway = pathToFileURL(path.join(ROOT, 'api', 'batch', 'v1', '[rpc].ts')).href;
    await writeFile(path.join(apiDir, 'batch', 'v1', '[rpc].js'), `export { default } from ${JSON.stringify(gateway)};\n`);
    await writeFile(path.join(apiDir, 'probe', 'v1', '[rpc].js'), PROBE_HANDLER);

    const { createLocalApiServer } = await import('../scripts/local/local-api-server.mjs');
    const { createPersonalIngress } = await import('../scripts/personal-server.mjs');
    const quiet = { log() {}, warn() {}, error() {} };
    const api = await createLocalApiServer({ port: 0, apiDir, cloudFallback: false, logger: quiet });
    const { port: apiPort } = await api.start();
    const ingress = await createPersonalIngress({ password: PASSWORD, distDir, apiPort, token: LOCAL_TOKEN });
    await new Promise<void>((resolve) => ingress.listen(0, '127.0.0.1', resolve));
    const address = ingress.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
    closeAll = async () => {
      ingress.closeAllConnections();
      await new Promise((resolve) => ingress.close(resolve));
      await api.close();
    };
  });

  after(async () => {
    await closeAll();
    if (previousToken === undefined) delete process.env.LOCAL_API_TOKEN;
    else process.env.LOCAL_API_TOKEN = previousToken;
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('returns each sub-operation\'s 200 body and never the transport token', async () => {
    const response = await clientFetch(`${base}/api/batch/v1/execute`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`owner:${PASSWORD}`).toString('base64')}`,
        'content-type': 'application/json',
        // A caller-supplied token is stripped at the ingress and is not what
        // authenticates the sub-requests.
        'x-worldmonitor-local-token': 'caller-supplied',
      },
      body: JSON.stringify({
        operations: [
          { id: 'first', path: '/api/probe/v1/first?iso2=KR' },
          { id: 'second', path: '/api/probe/v1/second' },
        ],
      }),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    const body = JSON.parse(text);
    assert.equal(body.succeeded, 2, text);
    assert.equal(body.failed, 0);
    const byId = Object.fromEntries(body.results.map((r: { id: string }) => [r.id, r]));
    assert.equal(byId.first.status, 200);
    assert.equal(byId.first.body.rpc, '/api/probe/v1/first');
    assert.equal(byId.first.body.query, '?iso2=KR');
    assert.equal(byId.second.status, 200);
    assert.equal(byId.second.body.rpc, '/api/probe/v1/second');
    assert.ok(!text.includes(LOCAL_TOKEN), 'the batch response must not carry the transport token');
    assert.ok(!text.includes('caller-supplied'));
    for (const [name, value] of response.headers) {
      assert.ok(!value.includes(LOCAL_TOKEN), `response header ${name} carries the transport token`);
    }
  });
});
