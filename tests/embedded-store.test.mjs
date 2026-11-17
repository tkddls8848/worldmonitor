import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import {
  SEED_LOCK_FENCED_SET_SCRIPT,
  SEED_LOCK_RENEW_SCRIPT,
  createEngine,
  startEmbeddedStore,
} from '../scripts/local/embedded-store.mjs';
import * as seedUtils from '../scripts/_seed-utils.mjs';
import { createPersonalFetch } from '../scripts/personal-tui.mjs';
import { DEFAULT_COLLECTORS, collectorScript } from '../scripts/personal-collect.mjs';

const TOKEN = 'embedded-store-test-token';

async function withStore(t, options = {}) {
  const store = await startEmbeddedStore({ token: TOKEN, port: 0, ...options });
  t.after(() => store.close());
  const url = `http://127.0.0.1:${store.port}`;
  const call = (pathname, init = {}) => fetch(`${url}${pathname}`, { ...init, headers: { authorization: `Bearer ${TOKEN}`, ...(init.headers || {}) } });
  const post = (pathname, body) => call(pathname, { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json());
  return { store, url, call, post };
}

test('strings honour TTL, NX and type checks', () => {
  let clock = 1_000;
  const engine = createEngine({ now: () => clock });
  assert.equal(engine.exec(['SET', 'a', '1', 'EX', '10']), 'OK');
  assert.equal(engine.exec(['SET', 'a', '2', 'NX']), null);
  assert.equal(engine.exec(['INCR', 'a']), 2);
  assert.equal(engine.exec(['TTL', 'a']), 10);
  clock += 10_000;
  assert.equal(engine.exec(['GET', 'a']), null);
  assert.equal(engine.exec(['TTL', 'a']), -2);
  engine.exec(['LPUSH', 'list', 'x']);
  assert.throws(() => engine.exec(['GET', 'list']), /WRONGTYPE/);
  assert.throws(() => engine.exec(['FLUSHALL']), /unknown command/);
});

test('lists, hashes, sets and sorted sets answer in Redis reply shapes', () => {
  const engine = createEngine();
  engine.exec(['RPUSH', 'l', 'a', 'b', 'c']);
  engine.exec(['LPUSH', 'l', 'z']);
  assert.deepEqual(engine.exec(['LRANGE', 'l', '0', '-1']), ['z', 'a', 'b', 'c']);
  engine.exec(['LTRIM', 'l', '0', '1']);
  assert.equal(engine.exec(['LLEN', 'l']), 2);

  engine.exec(['HSET', 'h', 'f1', 'v1', 'f2', 'v2']);
  assert.deepEqual(engine.exec(['HGETALL', 'h']), ['f1', 'v1', 'f2', 'v2']);
  assert.deepEqual(engine.exec(['HMGET', 'h', 'f2', 'nope']), ['v2', null]);

  engine.exec(['SADD', 's', 'a', 'b', 'a']);
  assert.equal(engine.exec(['SCARD', 's']), 2);

  engine.exec(['ZADD', 'z', '3', 'c', '1', 'a', '2', 'b']);
  assert.deepEqual(engine.exec(['ZRANGE', 'z', '0', '-1', 'WITHSCORES']), ['a', '1', 'b', '2', 'c', '3']);
  assert.deepEqual(engine.exec(['ZRANGEBYSCORE', 'z', '(1', '+inf']), ['b', 'c']);
  assert.deepEqual(engine.exec(['ZREVRANGE', 'z', '0', '0']), ['c']);
  assert.equal(engine.exec(['ZREMRANGEBYSCORE', 'z', '-inf', '2']), 2);
  assert.deepEqual(engine.exec(['SCAN', '0', 'MATCH', '?']).at(1).sort(), ['h', 'l', 's', 'z']);
});

test('the seed-lock scripts are the bytes the seeder runtime sends', () => {
  assert.equal(SEED_LOCK_RENEW_SCRIPT, seedUtils.SEED_LOCK_RENEW_SCRIPT);
  assert.equal(SEED_LOCK_FENCED_SET_SCRIPT, seedUtils.SEED_LOCK_FENCED_SET_SCRIPT);
});

test('a fenced write lands only while the caller still owns the lock', () => {
  const engine = createEngine();
  engine.exec(['SET', 'lock', 'me', 'PX', '5000']);
  assert.deepEqual(engine.exec(['EVAL', SEED_LOCK_FENCED_SET_SCRIPT, '2', 'lock', 'data', 'me', '5000', 'payload', '60']), [1, '']);
  assert.equal(engine.exec(['GET', 'data']), 'payload');
  assert.deepEqual(engine.exec(['EVAL', SEED_LOCK_FENCED_SET_SCRIPT, '2', 'lock', 'data', 'someone-else', '5000', 'stolen', '']), [0, 'me']);
  assert.equal(engine.exec(['GET', 'data']), 'payload');
  assert.throws(() => engine.exec(['EVAL', 'return 1', '0']), /not supported/);
  assert.throws(() => engine.exec(['EVALSHA', 'ffff', '0']), /^Error: NOSCRIPT/);
});

test('a failed transaction leaves nothing behind', () => {
  const engine = createEngine();
  engine.exec(['SET', 'kept', 'before']);
  assert.throws(() => engine.transaction([['SET', 'kept', 'after'], ['SET', 'new', '1'], ['LPUSH', 'kept', 'x']]), /WRONGTYPE/);
  assert.equal(engine.exec(['GET', 'kept']), 'before');
  assert.equal(engine.exec(['EXISTS', 'new']), 0);
});

test('the REST surface matches what collectors and handlers call', async (t) => {
  const { url, call, post } = await withStore(t);
  assert.equal((await fetch(`${url}/get/a`)).status, 401);
  assert.equal((await fetch(`${url}/get/a`, { headers: { authorization: 'Bearer wrong-token-wrong-token' } })).status, 401);

  assert.deepEqual(await post('/', ['SET', 'seed:x', '{"n":1}', 'EX', '60']), { result: 'OK' });
  assert.deepEqual(await (await call(`/get/${encodeURIComponent('seed:x')}`)).json(), { result: '{"n":1}' });
  assert.deepEqual(await (await call('/set/path%2Fkey/v/EX/60', { method: 'POST' })).json(), { result: 'OK' });
  assert.deepEqual(await post('/pipeline', [['GET', 'path/key'], ['NOPE'], ['GET', 'missing']]), [
    { result: 'v' },
    { error: "ERR unknown command 'NOPE' in the embedded personal store" },
    { result: null },
  ]);
  assert.deepEqual(await post('/multi-exec', [['SET', 'm', '1'], ['INCR', 'm']]), [{ result: 'OK' }, { result: 2 }]);
  const failed = await call('/multi-exec', { method: 'POST', body: JSON.stringify([['SET', 'm', '9'], ['LPUSH', 'm', 'x']]) });
  assert.equal(failed.status, 500);
  assert.deepEqual(await post('/', ['GET', 'm']), { result: '2' });
  assert.equal((await call('/', { method: 'POST', body: 'not json' })).status, 400);
});

test('the real rate-limit library is enforced against the store', async (t) => {
  const { url } = await withStore(t);
  const limiter = new Ratelimit({ redis: new Redis({ url, token: TOKEN }), limiter: Ratelimit.slidingWindow(2, '60 s'), prefix: 'rl' });
  const outcomes = [];
  for (let i = 0; i < 3; i += 1) outcomes.push((await limiter.limit('owner')).success);
  assert.deepEqual(outcomes, [true, true, false]);
});

test('data survives a restart and expired keys do not', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wm-embedded-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'nested', 'store.ndjson');
  const first = await startEmbeddedStore({ token: TOKEN, port: 0, file });
  first.engine.exec(['SET', 'kept', 'value']);
  first.engine.exec(['SET', 'gone', 'value', 'PX', '1']);
  first.engine.exec(['ZADD', 'scores', '2', 'b', '1', 'a']);
  first.engine.exec(['HSET', 'hash', 'f', 'v']);
  first.engine.exec(['SADD', 'set', 'm']);
  first.engine.exec(['RPUSH', 'list', '1', '2']);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await first.close();

  const second = await startEmbeddedStore({ token: TOKEN, port: 0, file });
  t.after(() => second.close());
  assert.equal(second.loaded, 5);
  assert.equal(second.engine.exec(['GET', 'kept']), 'value');
  assert.equal(second.engine.exec(['GET', 'gone']), null);
  assert.deepEqual(second.engine.exec(['ZRANGE', 'scores', '0', '-1']), ['a', 'b']);
  assert.equal(second.engine.exec(['HGET', 'hash', 'f']), 'v');
  assert.equal(second.engine.exec(['SISMEMBER', 'set', 'm']), 1);
  assert.deepEqual(second.engine.exec(['LRANGE', 'list', '0', '-1']), ['1', '2']);
});

test('the store refuses weak tokens and non-loopback binds', async () => {
  await assert.rejects(startEmbeddedStore({ token: 'short', port: 0 }), /at least 16/);
  await assert.rejects(startEmbeddedStore({ token: TOKEN, port: 0, host: '0.0.0.0' }), /loopback/);
});

test('the terminal dashboard sends the owner password to the personal server only', async () => {
  const seen = [];
  const fetchImpl = async (input, init = {}) => { seen.push([String(input), init.headers?.authorization]); return new Response('{}'); };
  const personalFetch = createPersonalFetch({ origin: 'http://127.0.0.1:3000', password: 'test-password-123456', fetchImpl });
  await personalFetch('http://127.0.0.1:3000/api/bootstrap?tier=fast', { headers: { accept: 'application/json' } });
  await personalFetch('https://gibs.earthdata.nasa.gov/wms');
  await personalFetch('http://127.0.0.1:3001/api/other-local-service');
  assert.equal(seen[0][1], `Basic ${Buffer.from('owner:test-password-123456').toString('base64')}`);
  assert.equal(seen[1][1], undefined);
  assert.equal(seen[2][1], undefined);
  assert.throws(() => createPersonalFetch({ origin: 'http://127.0.0.1:3000', password: '' }), /WM_PERSONAL_PASSWORD/);
});

test('every default collector exists and names cannot escape scripts/', () => {
  for (const name of DEFAULT_COLLECTORS) assert.match(collectorScript(name), /seed-[a-z0-9-]+\.mjs$/);
  assert.throws(() => collectorScript('../personal-server'), /Invalid collector name/);
  assert.throws(() => collectorScript('does-not-exist'), /Unknown collector/);
});

// The scenario worker (scripts/scenario-worker.mjs) claims jobs with BLMOVE,
// requeues orphans with LMOVE and acknowledges with LREM.
test('LMOVE and BLMOVE move one list element atomically', () => {
  const engine = createEngine();
  engine.exec(['RPUSH', 'pending', 'a', 'b', 'c']);
  assert.equal(engine.exec(['LMOVE', 'pending', 'processing', 'LEFT', 'RIGHT']), 'a');
  assert.equal(engine.exec(['BLMOVE', 'pending', 'processing', 'LEFT', 'RIGHT', '30']), 'b');
  assert.deepEqual(engine.exec(['LRANGE', 'processing', '0', '-1']), ['a', 'b']);
  assert.equal(engine.exec(['LMOVE', 'processing', 'pending', 'RIGHT', 'LEFT']), 'b');
  assert.deepEqual(engine.exec(['LRANGE', 'pending', '0', '-1']), ['b', 'c']);
  // Same list: a rotation.
  assert.equal(engine.exec(['LMOVE', 'pending', 'pending', 'LEFT', 'RIGHT']), 'b');
  assert.deepEqual(engine.exec(['LRANGE', 'pending', '0', '-1']), ['c', 'b']);
  // An empty source answers null and leaves the destination alone.
  assert.equal(engine.exec(['LMOVE', 'missing', 'processing', 'LEFT', 'RIGHT']), null);
  assert.equal(engine.exec(['BLMOVE', 'missing', 'processing', 'LEFT', 'RIGHT', '0']), null);
  assert.equal(engine.exec(['LLEN', 'processing']), 1);
  // The last element moved out drops the source key, as Redis does.
  engine.exec(['LMOVE', 'processing', 'pending', 'LEFT', 'LEFT']);
  assert.equal(engine.exec(['EXISTS', 'processing']), 0);
  engine.exec(['SET', 'str', 'x']);
  assert.throws(() => engine.exec(['LMOVE', 'pending', 'str', 'LEFT', 'RIGHT']), /WRONGTYPE/);
  assert.deepEqual(engine.exec(['LRANGE', 'pending', '0', '-1']), ['a', 'c', 'b'], 'a WRONGTYPE destination pops nothing');
  assert.throws(() => engine.exec(['LMOVE', 'pending', 'processing', 'UP', 'RIGHT']), /syntax error/);
  assert.throws(() => engine.exec(['BLMOVE', 'pending', 'processing', 'LEFT', 'RIGHT', '-1']), /timeout/);
});

test('BLMOVE over REST waits for a push and gives up at its timeout', async (t) => {
  const { post } = await withStore(t);
  const startedEmpty = Date.now();
  assert.deepEqual(await post('/', ['BLMOVE', 'q', 'p', 'LEFT', 'RIGHT', '0.2']), { result: null });
  assert.ok(Date.now() - startedEmpty >= 150, 'an empty queue blocks until the timeout');

  const waiting = post('/', ['BLMOVE', 'q', 'p', 'LEFT', 'RIGHT', '5']);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const pushedAt = Date.now();
  // The enqueue path (run-scenario) pushes inside MULTI/EXEC.
  assert.deepEqual(await post('/multi-exec', [['SET', 'owner', '1'], ['RPUSH', 'q', 'job-1']]), [{ result: 'OK' }, { result: 1 }]);
  assert.deepEqual(await waiting, { result: 'job-1' });
  assert.ok(Date.now() - pushedAt < 1000, 'the blocked client is woken by the push');
  assert.deepEqual(await post('/', ['LRANGE', 'p', '0', '-1']), { result: ['job-1'] });
  // Inside a pipeline a blocking command does not block.
  assert.deepEqual(await post('/pipeline', [['BLMOVE', 'q', 'p', 'LEFT', 'RIGHT', '5']]), [{ result: null }]);
});

test('a blocked BLMOVE does not hold the store open on close', async () => {
  const store = await startEmbeddedStore({ token: TOKEN, port: 0 });
  const url = `http://127.0.0.1:${store.port}`;
  const waiting = fetch(url, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: JSON.stringify(['BLMOVE', 'q', 'p', 'LEFT', 'RIGHT', '0']) })
    .then((r) => r.json(), () => 'disconnected');
  await new Promise((resolve) => setTimeout(resolve, 50));
  const closing = Date.now();
  await store.close();
  assert.ok(Date.now() - closing < 2000);
  await waiting;
  assert.equal(store.engine.exec(['EXISTS', 'p']), 0);
});

// End to end: the real worker process against the store, as start:personal
// runs it. The worker idles 5 s between empty polls, so a job answered well
// inside that window proves it was handed over by the blocked BLMOVE.
test('the scenario worker picks up a queued job promptly and writes its result', async (t) => {
  const { url, post } = await withStore(t);
  const { spawn } = await import('node:child_process');
  const worker = spawn(process.execPath, [fileURLToPath(new URL('../scripts/scenario-worker.mjs', import.meta.url))], {
    env: { ...process.env, UPSTASH_REDIS_REST_URL: url, UPSTASH_REDIS_REST_TOKEN: TOKEN },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  worker.stdout.on('data', (chunk) => { log += chunk; });
  worker.stderr.on('data', (chunk) => { log += chunk; });
  t.after(() => worker.kill());
  for (let i = 0; i < 100 && !log.includes('listening'); i += 1) await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 300)); // let it reach BLMOVE

  const owner = 'a'.repeat(64);
  const jobId = `scenario:${Date.now()}:${'b'.repeat(32)}`;
  const pushedAt = Date.now();
  await post('/', ['RPUSH', 'scenario-queue:pending', JSON.stringify({ jobId, scenarioId: 'hormuz-tanker-blockade', iso2: null, enqueuedAt: pushedAt, owner })]);
  let record = null;
  while (Date.now() - pushedAt < 4000) {
    const { result } = await post('/', ['GET', `scenario-result:${owner}:${jobId}`]);
    record = result ? JSON.parse(result) : null;
    if (record && record.status !== 'processing') break;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.equal(record?.status, 'done', `worker log:\n${log}`);
  assert.equal(typeof record.result, 'object');
  assert.deepEqual(await post('/', ['LLEN', 'scenario-queue:processing']), { result: 0 });
});
