'use strict';

const assert = require('node:assert/strict');
const { once } = require('node:events');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const test = require('node:test');
// Node 24 loads the shared TypeScript module directly (type stripping), so the
// emergency codes have one source of truth across TS, ESM and CommonJS.
const { EMERGENCY_CODES } = require('../shared/aircraft-emergencies.ts');

function get(port, requestPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString(),
      }));
    });
    request.on('error', reject);
  });
}

async function stop(child) {
  if (child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit'),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode == null) child.kill('SIGKILL');
}

// Spawns the relay with the test preload and resolves { child, port } once
// test mode is ready. extraEnv layers on top of the shared baseline.
function spawnRelay(extraEnv) {
  const preload = path.join(__dirname, 'personal-providers-test-preload.cjs');
  const relay = path.join(__dirname, '../tests/_lib/personal-providers-host.cjs');
  const child = spawn(process.execPath, [relay], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      PORT: '0',
      RELAY_TEST_MODE: 'true',
      RELAY_SHARED_SECRET: '',
      I_UNDERSTAND_THIS_DISABLES_AUTH: 'true',
      RELAY_RATE_LIMIT_MAX: '1000',
      RELAY_OPENSKY_RATE_LIMIT_MAX: '1000',
      OPENSKY_429_COOLDOWN_MS: '60000',
      OPENSKY_REQUEST_SPACING_MS: '1',
      OPENSKY_CLIENT_ID: 'test-client',
      OPENSKY_CLIENT_SECRET: 'test-secret',
      NODE_OPTIONS: `--require=${preload}`,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let port;
  const ready = new Promise((resolve, reject) => {
    const onData = (chunk) => {
      output += chunk.toString();
      const portMatch = output.match(/WebSocket relay on port (\d+)/);
      if (portMatch) port = Number(portMatch[1]);
      if (port && output.includes('Test mode enabled')) resolve();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code !== null && code !== 0) reject(new Error(`relay exited ${code}: ${output}`));
    });
  });

  return {
    child,
    getOutput: () => output,
    ready: ready.then(() => ({ child, port })),
  };
}

// Mock Upstash REST endpoint: records every command, acknowledges writes, and
// can return a deterministic response sequence for a specific Redis key.
async function createUpstashMock({ setResponses = {}, getValues = {} } = {}) {
  const commands = [];
  const responseQueues = new Map(Object.entries(setResponses).map(([key, responses]) => [
    key,
    Array.isArray(responses) ? [...responses] : [responses],
  ]));
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      let command = null;
      try { command = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* non-JSON body */ }
      commands.push({ path: req.url, command });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.startsWith('/get/')) {
        const value = getValues[decodeURIComponent(req.url.slice('/get/'.length))];
        res.end(JSON.stringify({ result: value === undefined ? null : JSON.stringify(value) }));
        return;
      }
      if (req.url === '/pipeline') {
        res.end(JSON.stringify((Array.isArray(command) ? command : []).map(() => ({ result: null }))));
        return;
      }
      const key = Array.isArray(command) ? command[1] : null;
      const queue = responseQueues.get(key);
      const response = queue?.length
        ? queue.shift()
        : (command?.[0] === 'EVAL' ? { result: 1 } : { result: 'OK' });
      res.end(JSON.stringify(response));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    commands,
    setsFor: (key) => commands.filter(
      (entry) => Array.isArray(entry.command) && entry.command[0] === 'SET' && entry.command[1] === key,
    ),
    env: {
      UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${server.address().port}`,
      UPSTASH_REDIS_REST_TOKEN: 'test-upstash-token',
      UPSTASH_ALLOW_INSECURE_HTTP: 'true',
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

test('relay handlers expose bounded Google/OpenSky cooldowns and RSS fallback metrics', async () => {
  const { child, ready } = spawnRelay({
    RELAY_GOOGLE_FLIGHTS_RATE_LIMIT_MAX: '1000',
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    GF_429_COOLDOWN_MS: '60000',
    RELAY_TEST_GOOGLE_STATUS_SEQUENCE: '429',
    RELAY_TEST_OPENSKY_STATUS_SEQUENCE: '429,200',
    RELAY_TEST_OPENSKY_RETRY_AFTER_SECONDS: '999999',
    RELAY_TEST_OPENSKY_REMAINING_CREDITS: '0',
    RELAY_TEST_OPENSKY_MALFORMED_ENCODING: '1',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;

    const googleFirst = await get(port, '/google-flights/search?origin=DXB&destination=LHR&departure_date=2026-08-03');
    assert.equal(googleFirst.status, 502);
    assert.match(googleFirst.body, /Google Flights returned 429/);

    const googleDuringCooldown = await get(port, '/google-flights/search?origin=JFK&destination=LAX&departure_date=2026-08-04');
    assert.equal(googleDuringCooldown.status, 200);
    assert.equal(JSON.parse(googleDuringCooldown.body).cooldown, true);
    assert.ok(Number(googleDuringCooldown.headers['retry-after']) >= 1);

    const [openskyFirst, openskyQueued] = await Promise.all([
      get(port, '/opensky/states/all?lamin=1&lomin=1&lamax=2&lomax=2'),
      get(port, '/opensky/states/all?lamin=3&lomin=3&lamax=4&lomax=4'),
    ]);
    assert.equal(openskyFirst.status, 429);
    assert.equal(openskyQueued.headers['x-cache'], 'RATE-LIMITED', 'queued bbox must stop before a second upstream debit');
    assert.ok(Number(openskyFirst.headers['retry-after']) >= 86_000, 'relay must honor the bounded provider reset window');
    assert.ok(Number(openskyFirst.headers['retry-after']) <= 86_400, 'provider reset must be capped at 24 hours');
    assert.ok(Number(openskyQueued.headers['retry-after']) >= 86_000, 'queued response must share the provider reset window');

    const openskyDuringCooldown = await get(port, '/opensky/states/all?lamin=5&lomin=5&lamax=6&lomax=6');
    assert.equal(openskyDuringCooldown.status, 200);
    assert.equal(openskyDuringCooldown.headers['x-cache'], 'RATE-LIMITED');
    assert.ok(Number(openskyDuringCooldown.headers['retry-after']) >= 86_000);

    const noCacheFeed = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=no-cache';
    const rssFirstFailure = await get(port, `/rss?url=${encodeURIComponent(noCacheFeed)}`);
    assert.equal(rssFirstFailure.status, 502);
    assert.ok(Number(rssFirstFailure.headers['retry-after']) >= 1);
    const rssBackoffFailure = await get(port, `/rss?url=${encodeURIComponent(noCacheFeed)}`);
    assert.equal(rssBackoffFailure.status, 503);
    assert.ok(Number(rssBackoffFailure.headers['retry-after']) >= 1);

    const staleFeed = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=stale';
    const rssFresh = await get(port, `/rss?url=${encodeURIComponent(staleFeed)}`);
    assert.equal(rssFresh.status, 200);
    await sleep(25);
    const rssStale = await get(port, `/rss?url=${encodeURIComponent(staleFeed)}`);
    assert.equal(rssStale.status, 200);
    assert.equal(rssStale.headers['x-cache'], 'STALE');
    const rssBackoffStale = await get(port, `/rss?url=${encodeURIComponent(staleFeed)}`);
    assert.equal(rssBackoffStale.status, 200);
    assert.equal(rssBackoffStale.headers['x-cache'], 'BACKOFF-STALE');

    const aisEmpty = await get(port, '/ais/snapshot');
    assert.equal(aisEmpty.status, 200);

    const health = JSON.parse((await get(port, '/health')).body);
    assert.equal(health.status, 'degraded', 'top-level JSON status must not hide degraded ingestion');
    assert.equal(health.ingestion.status, 'degraded');
    assert.equal(health.ingestion.aisSnapshot.served, 0);
    assert.equal(health.ingestion.aisSnapshot.connected, false);
    assert.ok(!('theaterPosture' in health.ingestion), 'public /health must not expose theaterPosture (#3802 surface discipline)');

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.equal(metrics.googleFlights.requests, 2);
    assert.ok(metrics.googleFlights.throttle >= 2);
    assert.equal(metrics.googleFlights.fallback, 0, 'cooldown-only empty results are not usable fallback data');
    assert.ok(metrics.googleFlights.cooldownRemainingMs > 0);
    assert.equal(metrics.opensky.requests, 3);
    assert.ok(metrics.opensky.throttle >= 3);
    assert.equal(metrics.opensky.upstreamFetches, 1, 'one upstream 429 must atomically stop queued bbox work');
    assert.equal(metrics.opensky.rateLimitRemaining, 0);
    assert.ok(metrics.opensky.global429CooldownRemainingMs >= 86_000_000);
    assert.ok(metrics.rss.requests >= 5);
    assert.ok(metrics.rss.fallback >= 1);
    assert.ok(metrics.rss.backoffActiveFeeds >= 2);
    assert.ok(metrics.rss.maxBackoffRemainingMs > 0);
    assert.equal(metrics.aisSnapshot.success, 0);
    assert.equal(metrics.aisSnapshot.served, 0);
    assert.ok(metrics.aisSnapshot.terminalFailure >= 1);

    await new Promise((resolve) => setTimeout(resolve, 11_000));
    const agedHealth = JSON.parse((await get(port, '/health')).body);
    assert.equal(agedHealth.ingestion.aviation.coverage.requests, 0, 'request samples must age out of the rolling window');
    assert.equal(agedHealth.ingestion.aviation.coverage.status, 'degraded', 'active provider reset must remain visible after samples age out');
  } finally {
    await stop(child);
  }
});

test('RSS keeps serving the last good body after an upstream 403 enters backoff', async () => {
  const { child, ready } = spawnRelay({
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;
    const feedUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=forbidden';
    const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;

    const fresh = await get(port, requestPath);
    assert.equal(fresh.status, 200);

    await new Promise((resolve) => setTimeout(resolve, 25));

    const stale = await get(port, requestPath);
    assert.equal(stale.status, 200, stale.body);
    assert.equal(stale.headers['x-cache'], 'STALE');
    assert.match(stale.body, /<rss>/);

    const backoffStale = await get(port, requestPath);
    assert.equal(backoffStale.status, 200, backoffStale.body);
    assert.equal(backoffStale.headers['x-cache'], 'BACKOFF-STALE');
    assert.match(backoffStale.body, /<rss>/);

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.ok(metrics.rss.authRejection >= 1, 'the upstream 403 must remain observable');
    assert.ok(metrics.rss.fallback >= 2, 'both stale responses must be counted as fallback');
    assert.equal(metrics.rss.served, 3, 'fresh plus both stale responses must be served');
  } finally {
    await stop(child);
  }
});

test('RSS keeps serving the last good body after upstream 5xx and timeout failures', async () => {
  for (const [mode, outcome] of [['server-error', 'terminalFailure'], ['timeout', 'timeout']]) {
    const { child, ready } = spawnRelay({
      RELAY_RSS_RATE_LIMIT_MAX: '1000',
      RELAY_TEST_RSS_CACHE_TTL_MS: '10',
      RELAY_METRICS_WINDOW_SECONDS: '10',
    });

    try {
      const { port } = await ready;
      const feedUrl = `https://feeds.bbci.co.uk/news/world/rss.xml?test=${mode}`;
      const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;

      assert.equal((await get(port, requestPath)).status, 200);
      await sleep(25);

      const stale = await get(port, requestPath);
      assert.equal(stale.status, 200, stale.body);
      assert.equal(stale.headers['x-cache'], 'STALE');
      assert.match(stale.body, /<rss>/);

      const metrics = JSON.parse((await get(port, '/metrics')).body);
      assert.ok(metrics.rss[outcome] >= 1, `${mode} must remain observable`);
      assert.ok(metrics.rss.fallback >= 1, `${mode} must serve stale fallback`);
    } finally {
      await stop(child);
    }
  }
});

test('RSS counts concurrent stale deduplication as fallback', async () => {
  const { child, ready } = spawnRelay({
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;
    const feedUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=dedup';
    const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;
    assert.equal((await get(port, requestPath)).status, 200);
    await sleep(25);

    const responses = await Promise.all([get(port, requestPath), get(port, requestPath)]);
    assert.ok(responses.every((response) => response.status === 200), responses.map((response) => response.body).join('\n'));
    assert.deepEqual(new Set(responses.map((response) => response.headers['x-cache'])), new Set(['STALE', 'DEDUP-STALE']));

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.ok(metrics.rss.authRejection >= 2, 'leader and dedup follower must retain the upstream rejection outcome');
    assert.ok(metrics.rss.fallback >= 2, 'leader and dedup follower must count as fallback');
    assert.equal(metrics.rss.served, 3, 'fresh, stale leader, and stale dedup follower must be served');
  } finally {
    await stop(child);
  }
});

test('RSS keeps concurrent timeout followers on the stale no-store path', async () => {
  const { child, ready } = spawnRelay({
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;
    const feedUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=dedup-timeout';
    const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;
    assert.equal((await get(port, requestPath)).status, 200);
    await sleep(25);

    const responses = await Promise.all([get(port, requestPath), get(port, requestPath)]);
    assert.ok(responses.every((response) => response.status === 200), responses.map((response) => response.body).join('\n'));
    assert.deepEqual(new Set(responses.map((response) => response.headers['x-cache'])), new Set(['STALE', 'DEDUP-STALE']));

    const metrics = JSON.parse((await get(port, '/metrics')).body);
    assert.ok(metrics.rss.timeout >= 2, 'leader and dedup follower must retain the timeout outcome');
    assert.ok(metrics.rss.fallback >= 2, 'leader and dedup follower must count as fallback');
    assert.equal(metrics.rss.served, 3, 'fresh, stale leader, and stale dedup follower must be served');
  } finally {
    await stop(child);
  }
});

test('RSS retains stale bodies while cleanup runs during active backoff', async () => {
  const { child, ready } = spawnRelay({
    RELAY_RSS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_RSS_CACHE_TTL_MS: '10',
    RELAY_TEST_RSS_CACHE_CLEANUP_INTERVAL_MS: '1000',
    RELAY_METRICS_WINDOW_SECONDS: '10',
  });

  try {
    const { port } = await ready;
    const feedUrl = 'https://feeds.bbci.co.uk/news/world/rss.xml?test=forbidden';
    const requestPath = `/rss?url=${encodeURIComponent(feedUrl)}`;
    assert.equal((await get(port, requestPath)).status, 200);
    await sleep(25);
    assert.equal((await get(port, requestPath)).headers['x-cache'], 'STALE');

    await sleep(1200);
    const backoffStale = await get(port, requestPath);
    assert.equal(backoffStale.status, 200, backoffStale.body);
    assert.equal(backoffStale.headers['x-cache'], 'BACKOFF-STALE');
  } finally {
    await stop(child);
  }
});

test('Wingbits bbox relay tiles wide viewports without silently clipping coverage', async () => {
  const { child, ready } = spawnRelay({
    WINGBITS_API_KEY: 'test-wingbits-key',
    RELAY_TEST_WINGBITS_ECHO_AREAS: '1',
  });

  try {
    const { port } = await ready;
    const response = await get(port, '/wingbits/track?lamin=0&lomin=0&lamax=60&lomax=60');
    assert.equal(response.status, 200, response.body);
    const payload = JSON.parse(response.body);
    assert.equal(payload.positions.length, 4, '60 by 60 degrees must be covered by four bounded tiles');
    assert.ok(payload.positions.every((position) =>
      position.lat >= 0 && position.lat <= 60 && position.lon >= 0 && position.lon <= 60
    ));
  } finally {
    await stop(child);
  }
});

// Google answers a rejected RPC with HTTP 200 and a `wrb.fr` row whose payload
// slot is null and whose error slot holds the RPC status. Captured verbatim
// from GetShoppingResults on 2026-10-16, when every search returned this.
// Results-page bodies in the live framing: the shopping payload is the `ds:1`
// block, and a rejected search carries `errorHasStatus: true` instead.
const googlePage = (dataJson) => `<script>AF_initDataCallback({key: 'ds:1', hash: '9', data:${dataJson}, sideChannel: {}});</script>`;
const GOOGLE_PAGE_REJECTION = `<script>AF_initDataCallback({key: 'ds:1',  data:[3,null,[["type.googleapis.com/travel.frontend.flights.ErrorResponse",[]]]],errorHasStatus: true,});</script>`;
const googleShoppingPage = (items) => googlePage(JSON.stringify([null, null, items, null]));
const googleFlightRow = () => {
  const leg = [];
  Object.assign(leg, { 3: 'JFK', 6: 'LHR', 8: [18, 30], 10: [6, 45], 11: 435, 20: [2026, 11, 15], 21: [2026, 11, 16], 22: ['BA', '178'] });
  const flight = [];
  Object.assign(flight, { 2: [leg], 9: 435 });
  return [flight, [[null, 512]]];
};

test('Google Flights rejections fail the relay call instead of reading as zero flights', async () => {
  const { child, ready } = spawnRelay({
    RELAY_GOOGLE_FLIGHTS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_GOOGLE_STATUS_SEQUENCE: Array(11).fill('200').join(','),
    RELAY_TEST_GOOGLE_BODY_SEQUENCE: JSON.stringify([
      GOOGLE_PAGE_REJECTION,
      ...Array(8).fill(GOOGLE_PAGE_REJECTION),
      googleShoppingPage(null),
      googleShoppingPage([[googleFlightRow()]]),
    ]),
  });

  try {
    const { port } = await ready;

    const rejected = await get(port, '/google-flights/search?origin=JFK&destination=LHR&departure_date=2026-11-15');
    assert.equal(rejected.status, 502, 'an error page is an upstream failure, not an empty result');
    assert.match(JSON.parse(rejected.body).error, /Google Flights rejected the search/);

    const rejectedDates = await get(port, '/google-flights/search-dates?origin=JFK&destination=LHR&start_date=2026-11-15&end_date=2026-11-22');
    assert.equal(rejectedDates.status, 502);
    assert.match(JSON.parse(rejectedDates.body).error, /Google Flights rejected the search/);

    const empty = await get(port, '/google-flights/search?origin=JFK&destination=LHR&departure_date=2026-11-16');
    assert.equal(empty.status, 200, 'a well-formed payload without flight rows is a genuine empty result');
    assert.deepEqual(JSON.parse(empty.body).flights, []);

    const found = await get(port, '/google-flights/search?origin=JFK&destination=LHR&departure_date=2026-11-17');
    assert.equal(found.status, 200);
    const [flight] = JSON.parse(found.body).flights;
    assert.equal(flight.price, 512);
    assert.equal(flight.legs[0].flightNumber, '178');
  } finally {
    await stop(child);
  }
});

test('Google Flights pages or rows in an unexpected shape fail instead of reading as results', async () => {
  const { child, ready } = spawnRelay({
    RELAY_GOOGLE_FLIGHTS_RATE_LIMIT_MAX: '1000',
    RELAY_TEST_GOOGLE_STATUS_SEQUENCE: '200,200,200,200',
    RELAY_TEST_GOOGLE_BODY_SEQUENCE: JSON.stringify([
      '<html><body>Our systems have detected unusual traffic</body></html>',
      googlePage('{}'),
      googlePage('[1,'),
      googleShoppingPage([[[[], []]]]),
    ]),
  });

  try {
    const { port } = await ready;
    for (const [day, reason] of [
      ['15', /Google Flights returned a page without flight results/],
      ['16', /Google Flights returned an unrecognized payload/],
      ['17', /Google Flights returned an unreadable results page/],
      ['18', /Google Flights returned flight rows in an unrecognized shape/],
    ]) {
      const response = await get(port, `/google-flights/search?origin=JFK&destination=LHR&departure_date=2026-11-${day}`);
      assert.equal(response.status, 502, `departure 2026-11-${day} must not read as a successful search`);
      assert.match(JSON.parse(response.body).error, reason);
    }
  } finally {
    await stop(child);
  }
});

// A relay deploy starts with an empty in-memory feed and waits
// TELEGRAM_STARTUP_DELAY_MS before its first poll. On 2026-10-27 that left
// /telegram/feed answering `enabled: true, items: []` for 3 minutes, and every
// open dashboard replaced 50 posts with "No messages available" on its next
// refresh. The last good poll is snapshotted to Redis and served until the new
// container polls.
const TELEGRAM_ITEMS_SNAPSHOT_KEY = 'intelligence:telegram-feed:items:v1';
