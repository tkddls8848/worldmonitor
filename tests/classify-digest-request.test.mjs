/**
 * #7437: Classify must read the digest from the install it belongs to.
 *
 * seedClassifyForVariant used to hardcode the production API host and
 * https.get, so a self-hosted relay asked production (non-200, swallowed)
 * and an in-network http:// API_BASE_URL threw. The request builder lives
 * in scripts/lib so these cases execute without importing the boot-on-require
 * relay — same reason as digest-stale-gate.cjs.
 *
 * Run: node --test tests/classify-digest-request.test.mjs
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
const {
  DEFAULT_CLASSIFY_API_BASE,
  resolveClassifyApiBase,
  buildClassifyDigestUrl,
  classifyDigestTransport,
  buildClassifyDigestHeaders,
  formatClassifyDigestFetchFailure,
  shouldWriteClassifySeedMeta,
  CLASSIFY_DIGEST_RETRY_DELAYS_MS,
  isTransientClassifyDigestFetchError,
  isRetryableClassifyDigestStatus,
  classifyDigestRetryDecision,
} = require('../scripts/lib/classify-digest-request.cjs');

const relaySrc = readFileSync(resolve(__dirname, '..', 'scripts', 'personal-providers.cjs'), 'utf8');

function classifyFnSrc() {
  const start = relaySrc.indexOf('async function seedClassifyForVariant');
  const end = relaySrc.indexOf('\nasync function seedClassify()', start);
  assert.ok(start >= 0 && end > start, 'seedClassifyForVariant not found');
  return relaySrc.slice(start, end);
}

describe('classify digest request builder (#7437)', () => {
  it('defaults to the personal server, never the upstream API, when API_BASE_URL is unset', () => {
    assert.equal(DEFAULT_CLASSIFY_API_BASE, 'http://127.0.0.1:3000');
    assert.equal(resolveClassifyApiBase({}), DEFAULT_CLASSIFY_API_BASE);
    assert.equal(resolveClassifyApiBase({ API_BASE_URL: '   ' }), DEFAULT_CLASSIFY_API_BASE);
    assert.equal(
      resolveClassifyApiBase({ WM_PERSONAL_HOST: '10.0.0.5', WM_PERSONAL_PORT: '4000' }),
      'http://10.0.0.5:4000',
      'follows the personal server host and port, like personalOrigin()',
    );
    assert.equal(
      buildClassifyDigestUrl('full', {}),
      `${DEFAULT_CLASSIFY_API_BASE}/api/news/v1/list-feed-digest?variant=full&lang=en`,
    );
    assert.ok(!/worldmonitor\.app/i.test(buildClassifyDigestUrl('full', {})));
  });

  it('honors API_BASE_URL, including an in-network http base with a trailing slash', () => {
    const env = { API_BASE_URL: 'http://worldmonitor:8080/' };
    assert.equal(resolveClassifyApiBase(env), 'http://worldmonitor:8080');
    assert.equal(
      buildClassifyDigestUrl('tech', env),
      'http://worldmonitor:8080/api/news/v1/list-feed-digest?variant=tech&lang=en',
    );
    assert.equal(classifyDigestTransport(buildClassifyDigestUrl('tech', env)), 'http');
  });

  it('selects https for the production default and encodes the variant', () => {
    const url = buildClassifyDigestUrl('happy go', { API_BASE_URL: 'https://api.example.test' });
    assert.equal(
      url,
      'https://api.example.test/api/news/v1/list-feed-digest?variant=happy%20go&lang=en',
    );
    assert.equal(classifyDigestTransport(url), 'https');
  });

  it('sends X-WorldMonitor-Key only when WORLDMONITOR_RELAY_KEY is set', () => {
    assert.deepEqual(
      buildClassifyDigestHeaders({ userAgent: 'WM-Test/1', relayKey: '' }),
      { Accept: 'application/json', 'User-Agent': 'WM-Test/1' },
    );
    assert.deepEqual(
      buildClassifyDigestHeaders({ userAgent: 'WM-Test/1', relayKey: 'relay-secret' }),
      {
        Accept: 'application/json',
        'User-Agent': 'WM-Test/1',
        'X-WorldMonitor-Key': 'relay-secret',
      },
    );
  });

  it('names the HTTP status so a failed digest fetch is not silent zeros', () => {
    assert.match(
      formatClassifyDigestFetchFailure(401, ''),
      /HTTP 401.*WORLDMONITOR_RELAY_KEY not set/,
    );
    assert.match(
      formatClassifyDigestFetchFailure(403, ''),
      /HTTP 403.*WORLDMONITOR_RELAY_KEY not set/,
    );
    assert.equal(
      formatClassifyDigestFetchFailure(502, ''),
      '[Classify] digest fetch failed: HTTP 502',
    );
    assert.equal(
      formatClassifyDigestFetchFailure(403, 'set'),
      '[Classify] digest fetch failed: HTTP 403',
    );
  });

  it('withholds seed-meta after an all-variant digest fetch failure', () => {
    assert.equal(shouldWriteClassifySeedMeta({ fetchOk: 0, fetchFailed: 5 }), false);
    assert.equal(shouldWriteClassifySeedMeta({ fetchOk: 1, fetchFailed: 4 }), true);
    assert.equal(shouldWriteClassifySeedMeta({ fetchOk: 0, fetchFailed: 0 }), true);
  });

  it('retries connection refusals and 502/503/504, not auth failures', () => {
    assert.equal(isTransientClassifyDigestFetchError({ code: 'ECONNREFUSED' }), true);
    assert.equal(isTransientClassifyDigestFetchError(new Error('timeout')), true);
    assert.equal(isTransientClassifyDigestFetchError(new Error('socket hang up')), true);
    assert.equal(isTransientClassifyDigestFetchError(new Error('certificate has expired')), false);
    assert.equal(isRetryableClassifyDigestStatus(502), true);
    assert.equal(isRetryableClassifyDigestStatus(503), true);
    assert.equal(isRetryableClassifyDigestStatus(504), true);
    assert.equal(isRetryableClassifyDigestStatus(401), false);
    assert.equal(isRetryableClassifyDigestStatus(403), false);
    assert.equal(isRetryableClassifyDigestStatus(200), false);

    assert.deepEqual(
      classifyDigestRetryDecision({ attempt: 0, error: { code: 'ECONNREFUSED' } }),
      { retry: true, delayMs: 2000 },
    );
    assert.deepEqual(
      classifyDigestRetryDecision({ attempt: 1, status: 503 }),
      { retry: true, delayMs: 4000 },
    );
    assert.deepEqual(
      classifyDigestRetryDecision({ attempt: 0, status: 401 }),
      { retry: false, delayMs: 0 },
    );
    assert.deepEqual(
      classifyDigestRetryDecision({
        attempt: CLASSIFY_DIGEST_RETRY_DELAYS_MS.length,
        error: { code: 'ECONNREFUSED' },
      }),
      { retry: false, delayMs: 0 },
    );
  });
});
