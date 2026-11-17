import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPersonalIngress, validatePersonalStore } from '../scripts/personal-server.mjs';

test('personal storage rejects remote endpoints and accepts only local HTTP stores', () => {
  for (const value of [undefined, 'http://localhost:8079', 'http://127.0.0.1:8079', 'http://[::1]:8079']) assert.doesNotThrow(() => validatePersonalStore(value));
  for (const value of ['https://example.upstash.io', 'http://localhost.evil.test', 'file:///tmp/db', 'http://user:pass@localhost']) assert.throws(() => validatePersonalStore(value));
});

test('personal ingress protects assets/API and strips client transport credentials', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wm-personal-'));
  await writeFile(path.join(dir, 'dashboard.html'), '<html lang="ko">개인용</html>');
  const api = http.createServer((req, res) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(req.headers)); });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const server = await createPersonalIngress({ password: 'test-password-123456', distDir: dir, apiPort: api.address().port, token: 'internal-only' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); api.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => api.close(r))]); await rm(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { authorization: `Basic ${Buffer.from('owner:test-password-123456').toString('base64')}` };
  assert.equal((await fetch(base)).status, 401);
  assert.equal((await fetch(`${base}/api/example`)).status, 401);
  assert.equal((await fetch(base, { headers })).status, 200);
  assert.equal((await fetch(`${base}/%2e%2e%2fsecret`, { headers })).status, 400);
  assert.equal((await fetch(`${base}/api/example`, { headers: { ...headers, origin: 'https://evil.example' } })).status, 403);
  const response = await fetch(`${base}/api/example`, { headers: { ...headers, 'x-worldmonitor-local-token': 'attacker', 'x-forwarded-for': 'attacker' } });
  const forwarded = await response.json();
  assert.equal(forwarded.authorization, undefined);
  assert.equal(forwarded['x-worldmonitor-local-token'], 'internal-only');
  assert.equal(forwarded['x-forwarded-for'], undefined);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

// The gateway no longer authenticates anything: this check is the only gate in
// front of every route, so no method or path shape may reach the API without it.
test('personal ingress challenges every method and path before the API sees it', async t => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wm-personal-'));
  await writeFile(path.join(dir, 'dashboard.html'), '<html lang="ko">개인용</html>');
  let upstreamHits = 0;
  const api = http.createServer((_req, res) => { upstreamHits += 1; res.end('{}'); });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const server = await createPersonalIngress({ password: 'test-password-123456', distDir: dir, apiPort: api.address().port, token: 'internal-only' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); api.closeAllConnections(); await Promise.all([new Promise(r => server.close(r)), new Promise(r => api.close(r))]); await rm(dir, { recursive: true }); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const wrong = { authorization: `Basic ${Buffer.from('owner:not-the-password-0000').toString('base64')}` };
  const paths = [
    '/api/supply-chain/v1/get-country-cost-shock?iso2=KR',
    '/api/scenario/v1/run-scenario',
    '/api/supply-chain/v1/get-country-cost-shock.md',
    '/api/chat-analyst',
    '/api/latest-brief',
    '/api/bootstrap?tier=fast',
    '/api/sidecar-health',
    '/api/service-status',
    '/api/youtube-embed?videoId=aaaaaaaaaaa',
    '/dashboard.html',
  ];
  for (const p of paths) {
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'DELETE']) {
      for (const headers of [{}, wrong, { authorization: 'Bearer anything' }]) {
        const res = await fetch(base + p, { method, headers });
        assert.equal(res.status, 401, `${method} ${p} ${JSON.stringify(headers)}`);
        assert.match(res.headers.get('www-authenticate') ?? '', /^Basic /);
        await res.arrayBuffer();
      }
    }
  }
  assert.equal(upstreamHits, 0, 'no unauthenticated request may reach the API server');
});

test('personal ingress refuses a missing or weak password', async () => {
  await assert.rejects(createPersonalIngress({ password: 'short' }), /at least 16/);
});
