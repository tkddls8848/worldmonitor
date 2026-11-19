// Container-free, password-protected ingress. Use an HTTPS reverse proxy for
// remote access; the default listener is deliberately loopback-only.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from './_seed-utils.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = value => createHash('sha256').update(value).digest();
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.wasm': 'application/wasm' };

export function validatePersonalStore(url) {
  if (!url) return;
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password) {
    throw new Error('Personal mode requires a loopback Redis REST URL; remote shared stores are disabled');
  }
}

export async function createPersonalIngress({ password, username = 'owner', distDir, apiPort, token }) {
  if (!password || password.length < 16) throw new Error('WM_PERSONAL_PASSWORD must contain at least 16 characters');
  if (!token) throw new Error('Internal API token is required');
  const root = await realpath(distDir);
  await stat(path.join(root, 'dashboard.html'));
  const expected = digest(`Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`);
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!timingSafeEqual(digest(req.headers.authorization || ''), expected)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="WorldMonitor personal", charset="UTF-8"' });
      res.end('인증이 필요합니다.');
      return;
    }
    try {
      // Inspect before URL normalization, including encoded separators and dots.
      const pathname = decodeURIComponent((req.url || '/').split('?')[0]);
      if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(p => p === '..' || p.startsWith('.'))) {
        res.writeHead(400); res.end(); return;
      }
      if (pathname.startsWith('/api/')) {
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) {
          res.writeHead(403); res.end(); return;
        }
        const headers = { ...req.headers };
        for (const key of Object.keys(headers)) {
          if (key === 'authorization' || key === 'forwarded' || key.startsWith('x-forwarded-') || key === 'x-real-ip' || key === 'x-worldmonitor-local-token') delete headers[key];
        }
        headers['x-worldmonitor-local-token'] = token;
        headers['x-real-ip'] = req.socket.remoteAddress;
        headers['x-forwarded-host'] = req.headers.host;
        const upstream = http.request({ host: '127.0.0.1', port: apiPort, path: req.url, method: req.method, headers }, response => {
          const outgoing = { ...response.headers, 'cache-control': 'private, no-store' };
          delete outgoing['x-worldmonitor-local-token'];
          res.writeHead(response.statusCode || 502, outgoing);
          response.pipe(res);
        });
        upstream.setTimeout(60_000, () => upstream.destroy());
        upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
        req.on('aborted', () => upstream.destroy());
        req.pipe(upstream);
        return;
      }
      if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405); res.end(); return; }
      let target = path.join(root, pathname === '/' || pathname === '/dashboard' || pathname === '/dashboard/' ? 'dashboard.html' : pathname);
      try { target = await realpath(target); } catch { res.writeHead(404); res.end(); return; }
      const relative = path.relative(root, target);
      if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(target)).isFile()) { res.writeHead(404); res.end(); return; }
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': MIME[path.extname(target)] || 'application/octet-stream', 'Content-Length': body.length });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch { if (!res.headersSent) res.writeHead(400); res.end(); }
  });
}

// WM_PERSONAL_STORE=embedded runs the data store inside this process, at the
// loopback address the collectors already read from UPSTASH_REDIS_REST_URL.
export async function startPersonalStore(env = process.env) {
  if (env.WM_PERSONAL_STORE !== 'embedded') return null;
  const url = new URL(env.UPSTASH_REDIS_REST_URL || 'http://127.0.0.1:8079');
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('WM_PERSONAL_STORE=embedded requires UPSTASH_REDIS_REST_URL=http://127.0.0.1:<port>');
  }
  const { startEmbeddedStore } = await import('./local/embedded-store.mjs');
  const store = await startEmbeddedStore({
    token: env.UPSTASH_REDIS_REST_TOKEN,
    host: url.hostname,
    port: Number(url.port || 80),
    file: path.resolve(ROOT, env.WM_PERSONAL_STORE_FILE || '.personal/store.ndjson'),
  });
  env.UPSTASH_REDIS_REST_URL = url.origin;
  console.log(`내장 저장소: ${url.origin} (복원된 키 ${store.loaded}개)`);
  return store;
}

// run-scenario only enqueues on scenario-queue:pending. Upstream an always-on
// Railway service runs scripts/scenario-worker.mjs; here it lives and dies with
// this server and reads the same store through UPSTASH_REDIS_REST_URL. A crash
// is restarted after a pause; the worker requeues its own orphaned jobs.
export function startScenarioWorker({ env = process.env, spawnImpl = spawn, restartDelayMs = 5_000, log = console } = {}) {
  const childEnv = { ...env };
  delete childEnv.LOCAL_API_TOKEN; // authenticates ingress -> API only
  let child = null;
  let closed = false;
  let restartTimer = null;
  const launch = () => {
    child = spawnImpl(process.execPath, [path.join(ROOT, 'scripts', 'scenario-worker.mjs')], { env: childEnv, stdio: ['ignore', 'inherit', 'inherit'] });
    child.once('exit', (code, signal) => {
      child = null;
      if (closed) return;
      log.warn(`시나리오 작업자가 종료되었습니다(${code ?? signal}). ${restartDelayMs / 1000}초 뒤 다시 시작합니다.`);
      restartTimer = setTimeout(launch, restartDelayMs);
    });
  };
  launch();
  return {
    async close() {
      closed = true;
      clearTimeout(restartTimer);
      const running = child;
      if (!running) return;
      const exited = new Promise((resolve) => running.once('exit', resolve));
      running.kill('SIGTERM');
      // SIGTERM lets a computing job finish, but an idle worker sits in a
      // 30 s BLMOVE before it looks at the flag, so it is forced after 3 s.
      const forced = setTimeout(() => running.kill('SIGKILL'), 3_000);
      await exited;
      clearTimeout(forced);
    },
  };
}

// News-catalog feeds whose URL is a path (/api/miit-news) are this fork's own
// API routes. The digest builder runs in this process and reaches them through
// the local API, which listens on a random loopback port
// (server/_shared/own-api-feed.ts).
export function publishLocalApiOrigin(apiPort, env = process.env) {
  env.LOCAL_API_ORIGIN = `http://127.0.0.1:${apiPort}`;
}

export async function startPersonalServer() {
  loadEnvFile(import.meta.url);
  validatePersonalStore(process.env.UPSTASH_REDIS_REST_URL);
  if (process.env.WM_PERSONAL_STORE !== 'embedded' && (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN)) {
    console.warn('로컬 데이터 저장소가 설정되지 않았습니다. Redis 기반 수집 데이터와 시나리오 작업은 사용할 수 없습니다.');
  }
  if (!process.env.WM_PERSONAL_PASSWORD || process.env.WM_PERSONAL_PASSWORD.length < 16) throw new Error('Set WM_PERSONAL_PASSWORD (at least 16 characters) in .env.local');
  process.env.LOCAL_API_MODE = 'docker';
  process.env.LOCAL_API_CLOUD_FALLBACK = 'false';
  process.env.LOCAL_API_TOKEN = randomBytes(32).toString('hex');
  // Started only after every setting above is known good: a listening store
  // would otherwise keep a misconfigured process alive.
  const store = await startPersonalStore();
  let api;
  let worker = null;
  try {
    const { createLocalApiServer } = await import('./local/local-api-server.mjs');
    api = await createLocalApiServer({ port: 0, mode: 'docker', resourceDir: ROOT, cloudFallback: false });
    const { port: apiPort } = await api.start();
    publishLocalApiOrigin(apiPort);
    const server = await createPersonalIngress({ password: process.env.WM_PERSONAL_PASSWORD, username: process.env.WM_PERSONAL_USERNAME || 'owner', distDir: path.join(ROOT, 'dist'), apiPort, token: process.env.LOCAL_API_TOKEN });
    const port = Number(process.env.WM_PERSONAL_PORT || 3000);
    const host = process.env.WM_PERSONAL_HOST || '127.0.0.1';
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
    // Only with a store to read jobs from; the warning above covers the rest.
    worker = process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN ? startScenarioWorker() : null;
    const close = async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await worker?.close(); await api.close(); await store?.close(); };
    process.once('SIGINT', () => void close());
    process.once('SIGTERM', () => void close());
    console.log(`개인용 WorldMonitor: http://${host}:${port} (외부 접속에는 HTTPS 프록시를 사용하세요)`);
    return { server, close };
  } catch (error) { await worker?.close(); await api?.close(); await store?.close(); throw error; }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  startPersonalServer().catch(error => { console.error(error.message); process.exitCode = 1; });
}
