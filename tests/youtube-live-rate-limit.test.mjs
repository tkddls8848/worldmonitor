// Rate-limit coverage for api/youtube/live.js (#6234).
//
// The route calls youtube.com's oEmbed from our egress IPs and, before this
// suite, had no meter at all: `isDisallowedOrigin` is a CORS check and does
// nothing against a non-browser caller. Channel live detection is retired (410),
// but it is still metered first, so the assertion with teeth here is not the
// 429 status but that a limited request never reaches youtube.com.

import { afterEach, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertLimiterBudget } from './helpers/upstash-limiter-wire.mjs';

const originalEnv = { ...process.env };
const originalFetch = globalThis.fetch;

// Delete before import so the handler cannot memoize a limiter against a
// half-configured environment; each test opts in explicitly.
delete process.env.UPSTASH_REDIS_REST_URL;
delete process.env.UPSTASH_REDIS_REST_TOKEN;
delete process.env.WS_RELAY_URL;

const { default: handler } = await import('../api/youtube/live.js');

const ENDPOINT = 'https://api.worldmonitor.app/api/youtube/live';

let ipCounter = 0;
/** Distinct caller per test — the limiter memoizes per scope, so a shared IP
 *  would let one test's verdict leak into the next. */
function uniqueCallerIp() {
  ipCounter += 1;
  return `203.0.113.${ipCounter}`;
}

function makeRequest(query, ip) {
  return new Request(`${ENDPOINT}?${query}`, {
    headers: { Origin: 'https://worldmonitor.app', 'x-real-ip': ip },
  });
}

/** Records every fetch the handler makes. `respond` decides the reply. */
function spyFetch(respond) {
  const calls = [];
  globalThis.fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init, calls);
  };
  return calls;
}

const youtubeCalls = (calls) => calls.filter((c) => c.url.includes('youtube.com'));

function upstashReply(remaining, limit) {
  return new Response(JSON.stringify([{ result: [remaining, limit] }]), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  process.env.UPSTASH_REDIS_REST_URL = 'https://fake-upstash.example';
  process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});




test('allows the request through when the limiter reports headroom', async () => {
  // Positive control: proves the 429 above comes from the limiter verdict and
  // not merely from Upstash being configured at all.
  const calls = spyFetch((url) => (
    url.includes('fake-upstash')
      ? upstashReply(29, 30)
      : new Response(JSON.stringify({ author_name: 'Test Channel', title: 'Live' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
  ));

  // A malformed Upstash reply also yields a pass — checkRateLimit catches the
  // parse error and fail-opens — so status alone cannot distinguish "granted
  // headroom" from "threw and failed open". Capture the degraded log too.
  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest('videoId=dQw4w9WgXcQ', uniqueCallerIp()));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 200);
  assert.equal((await res.json()).channelName, 'Test Channel');
  assert.ok(
    youtubeCalls(calls).some((c) => c.url.includes('/oembed')),
    'a request with headroom must reach the oembed fallback',
  );
  assert.ok(
    !errorLogs.some((l) => l.includes('[rate-limit] redis-error')),
    `limiter degraded (fail-open) instead of granting headroom: ${errorLogs.join(' | ')}`,
  );
});

test('stays available when Upstash is unconfigured', async () => {
  // Availability-first posture: this is a read proxy for the live-stream panel,
  // so a missing/blipping Redis must degrade to today's behaviour rather than
  // blanking the panel. Documented in the ENDPOINT_RATE_POLICIES comment.
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;

  const calls = spyFetch(() => new Response(
    JSON.stringify({ author_name: 'Test Channel', title: 'Live' }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  ));

  // 200 + one upstream call is satisfied by BOTH the intended path (no limiter
  // constructed) and the unintended one (a memoized limiter throws and the
  // handler fails open), so capture the degraded marker to tell them apart —
  // the same probe the positive control above uses. (#6412 review)
  const errorLogs = [];
  const originalConsoleError = console.error;
  console.error = (...args) => { errorLogs.push(args.join(' ')); };
  let res;
  try {
    res = await handler(makeRequest('videoId=dQw4w9WgXcQ', uniqueCallerIp()));
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(res.status, 200);
  assert.ok(youtubeCalls(calls).some((c) => c.url.includes('/oembed')));
  assert.ok(
    !errorLogs.some((l) => l.includes('[rate-limit] redis-error')),
    `unconfigured Upstash must skip the limiter entirely, not construct one and fail open: ${errorLogs.join(' | ')}`,
  );
});
