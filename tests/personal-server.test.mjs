import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPersonalIngress, validatePersonalStore } from '../scripts/personal-server.mjs';

test('personal storage rejects remote endpoints and accepts only local HTTP stores', () => {
  for (const value of [undefined, 'http://localhost:8079', 'http://127.0.0.1:8079', 'http://[::1]:8079']) assert.doesNotThrow(() => validatePersonalStore(value));
  for (const value of ['https://example.upstash.io', 'http://localhost.evil.test', 'file:///tmp/db', 'http://user:pass@localhost']) assert.throws(() => validatePersonalStore(value));
});

async function startIngress(t, allowedHosts) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wm-personal-'));
  await writeFile(path.join(dir, 'dashboard.html'), '<html>WorldMonitor</html>');
  let hits = 0;
  const api = http.createServer((req, res) => {
    hits += 1;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(req.headers));
  });
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  const server = await createPersonalIngress({ distDir: dir, apiPort: api.address().port, token: 'internal-only', allowedHosts });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    api.closeAllConnections();
    await Promise.all([new Promise(r => server.close(r)), new Promise(r => api.close(r))]);
    await rm(dir, { recursive: true });
  });
  const { port } = server.address();
  return { port, base: 'http://127.0.0.1:' + port, upstreamHits: () => hits };
}

// fetch may rewrite Host and Sec-Fetch headers. Send the actual wire values here.
function request(base, { method = 'GET', headers } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base, { method, headers }, (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
      res.once('error', reject);
    });
    req.once('error', reject);
    req.end();
  });
}

test('personal ingress serves the dashboard and API without credentials', async t => {
  const { base } = await startIngress(t);
  const dashboard = await fetch(base + '/dashboard');
  assert.equal(dashboard.status, 200);
  assert.equal(dashboard.headers.get('www-authenticate'), null);
  assert.equal((await fetch(base + '/api/example')).status, 200);
  assert.equal((await fetch(base + '/api/local-providers/oref/alerts')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e%2fsecret')).status, 400);

  const response = await fetch(base + '/api/example', {
    headers: {
      origin: base,
      authorization: 'Bearer client-supplied',
      'x-worldmonitor-local-token': 'client-supplied',
      'x-forwarded-for': 'client-supplied',
    },
  });
  assert.equal(response.status, 200);
  const forwarded = await response.json();
  assert.equal(forwarded.authorization, undefined);
  assert.equal(forwarded['x-worldmonitor-local-token'], 'internal-only');
  assert.equal(forwarded['x-forwarded-for'], undefined);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
});

test('personal ingress rejects unlisted Host values before serving assets or forwarding API requests', async t => {
  const { base, port, upstreamHits } = await startIngress(t);
  for (const host of ['foreign.example:' + port, 'localhost.foreign.example:' + port, 'localhost', '127.0.0.1:1']) {
    assert.equal(await request(base + '/dashboard', { headers: { host } }), 403, host);
    for (const method of ['GET', 'HEAD', 'POST', 'OPTIONS', 'PUT', 'DELETE']) {
      assert.equal(await request(base + '/api/example', { method, headers: { host } }), 403, method);
    }
  }
  assert.equal(upstreamHits(), 0);
  for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
    assert.equal(await request(base + '/dashboard', { headers: { host: host + ':' + port } }), 200, host);
  }
});

test('personal ingress honors exact configured proxy Host values', async t => {
  const { base } = await startIngress(t, ' proxy.example, custom.example:8443 ,');
  assert.equal(await request(base + '/dashboard', { headers: { host: 'proxy.example' } }), 200);
  assert.equal(await request(base + '/api/example', {
    method: 'POST',
    headers: { host: 'custom.example:8443', origin: 'https://custom.example:8443', 'sec-fetch-site': 'same-origin' },
  }), 200);
  for (const host of ['sub.proxy.example', 'proxy.example:1234', 'custom.example']) {
    assert.equal(await request(base + '/dashboard', { headers: { host } }), 403, host);
  }
});

test('personal ingress rejects cross-origin and cross-site API requests before forwarding', async t => {
  const { base, upstreamHits } = await startIngress(t);
  assert.equal(await request(base + '/api/example', { method: 'POST', headers: { origin: 'https://foreign.example' } }), 403);
  assert.equal(await request(base + '/api/example', { headers: { origin: 'http://127.0.0.1:1' } }), 403);
  assert.equal(await request(base + '/api/example', { headers: { origin: base.replace('http:', 'https:') } }), 403);
  assert.equal(await request(base + '/api/example', { headers: { 'sec-fetch-site': 'cross-site' } }), 403);
  assert.equal(upstreamHits(), 0);
  assert.equal(await request(base + '/api/example', { headers: { 'sec-fetch-site': 'same-origin' } }), 200);
});

test('personal server refuses a non-loopback bind before starting dependencies', async () => {
  for (const host of ['0.0.0.0', '::', '192.168.0.1', 'example.test']) {
    const result = spawnSync(process.execPath, ['scripts/personal-server.mjs'], {
      env: { ...process.env, WM_PERSONAL_HOST: host },
      encoding: 'utf8',
      timeout: 5000,
    });
    assert.equal(result.status, 1, host);
    assert.match(result.stderr, /WM_PERSONAL_HOST must be/);
  }
});

test('the scenario worker runs with the server, against its store, and stops with it', async () => {
  const { EventEmitter } = await import('node:events');
  const { startScenarioWorker } = await import('../scripts/personal-server.mjs');
  const spawned = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.signals = [];
    child.kill = (signal = 'SIGTERM') => { child.signals.push(signal); setImmediate(() => child.emit('exit', null, signal)); return true; };
    spawned.push({ command, args, options, child });
    return child;
  };
  const env = { UPSTASH_REDIS_REST_URL: 'http://127.0.0.1:8079', UPSTASH_REDIS_REST_TOKEN: 'store-token-store-token', LOCAL_API_TOKEN: 'per-process-secret', PATH: 'x' };
  const warnings = [];
  const worker = startScenarioWorker({ env, spawnImpl, restartDelayMs: 10, log: { warn: (m) => warnings.push(m), log() {} } });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].command, process.execPath);
  assert.match(spawned[0].args[0], /scripts[\\/]scenario-worker\.mjs$/);
  assert.equal(spawned[0].options.env.UPSTASH_REDIS_REST_URL, 'http://127.0.0.1:8079');
  assert.equal(spawned[0].options.env.UPSTASH_REDIS_REST_TOKEN, 'store-token-store-token');
  assert.equal(spawned[0].options.env.LOCAL_API_TOKEN, undefined, 'the API transport token stays in the server');

  // A crash is restarted; a close is not.
  spawned[0].child.emit('exit', 1, null);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawned.length, 2);
  assert.equal(warnings.length, 1);
  await worker.close();
  assert.deepEqual(spawned[1].child.signals, ['SIGTERM']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(spawned.length, 2);
});

test('the local API origin is published in-process so own-API catalog feeds reach it', async () => {
  const { publishLocalApiOrigin } = await import('../scripts/personal-server.mjs');
  const env = {};
  publishLocalApiOrigin(45678, env);
  assert.equal(env.LOCAL_API_ORIGIN, 'http://127.0.0.1:45678');
});
