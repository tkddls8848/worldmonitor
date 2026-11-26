/**
 * Regression for issue #3802: the relay's /health endpoint was returning
 * attacker-aiding fields in its UNauthenticated response:
 *
 *   - `auth.authHeader` — revealed the non-standard header name
 *     (`x-relay-key`) attackers should target.
 *   - `auth.allowVercelPreviewOrigins` — CORS-policy leak.
 *   - `rateLimit: { windowMs, defaultMax, openskyMax, rssMax }` — exact
 *     thresholds that let attackers tune scraping cadence to stay under
 *     the throttle.
 *
 * The /health handler is in `isPublicRoute` and has no auth gate, so
 * this test source-greps the handler body to assert the three field
 * categories don't reappear.
 *
 * IMPORTANT: `auth.enabled` and `auth.sharedSecretEnabled` are
 * PRESERVED on purpose. PR #3812 / #3815 added them as the
 * operator-visible "is auth configured?" signal; their behaviour is
 * pinned by tests/relay-auth.test.mjs. The contract is "operators get
 * a coarse boolean; we don't reveal the credential header name or rate
 * thresholds."
 *
 * Inspired by:
 * ~/.claude/skills/test-ci-gotchas/reference/source-grep-regression-test-for-unexercisable-defensive-branch.md
 *
 * (Why source-grep: personal-providers.cjs is a 9600-line single-process daemon
 * that's not easily importable in node:test. Spawning the relay and
 * curl'ing /health is expensive and flaky for THIS check; the existing
 * relay-auth.test.mjs already pays that cost for the auth.enabled
 * contract.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const relaySourcePromise = readFile(
  new URL('../scripts/personal-providers.cjs', import.meta.url),
  'utf8',
);

async function getHealthHandlerBody() {
  const source = await relaySourcePromise;
  // Anchor the /health handler block. ~80-line handler — bound to 8000
  // chars to avoid runaway matching if the handler ever grows.
  const handlerMatch = source.match(
    /if \(pathname === '\/health' \|\| pathname === '\/'\) \{[\s\S]{0,8000}?\n\s{2}\}/,
  );
  assert.ok(handlerMatch, 'expected to find /health handler block in personal-providers.cjs');
  // Strip JS comments so the in-line doc comment that NAMES the removed
  // fields as a defense-in-depth note doesn't false-positive.
  return handlerMatch[0]
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

async function getConnectUpstreamBody() {
  const source = await relaySourcePromise;
  const start = source.indexOf('function connectUpstream() {');
  const end = source.indexOf('\nfunction close(', start);
  assert.ok(start >= 0 && end > start, 'expected to find connectUpstream() in personal-providers.cjs');
  return source.slice(start, end);
}

async function getSnapshotAvailabilityBody() {
  const source = await relaySourcePromise;
  const start = source.indexOf('function recordAisSnapshotAvailability(snapshot) {');
  const end = source.indexOf('\n}\n\nsetInterval(', start) + 2;
  assert.ok(start >= 0 && end > start, 'expected to find recordAisSnapshotAvailability()');
  return source.slice(start, end);
}

describe('ais-relay reconnect backoff contract (#5945)', () => {
  it('snapshot traffic cannot cancel a pending upstream reconnect timer', async () => {
    const body = await getConnectUpstreamBody();
    assert.match(
      body,
      /if \(upstreamReconnectTimer\) return;/,
      'connectUpstream() must preserve the scheduled exponential-backoff timer',
    );
    assert.doesNotMatch(
      body,
      /clearTimeout\(upstreamReconnectTimer\)/,
      'request-driven connect attempts must not clear the provider cooldown',
    );
  });

  it('request traffic cannot replace the current socket before its close handler releases ownership', async () => {
    const body = await getConnectUpstreamBody();
    assert.match(
      body,
      /if \(upstreamSocket\) return;/,
      'every non-null current socket, including CLOSING/CLOSED, must retain ownership until close',
    );
    assert.doesNotMatch(
      body,
      /upstreamSocket\?\.readyState === WebSocket\.(?:OPEN|CONNECTING)/,
      'readyState-only guards leave an error-to-close replacement gap',
    );
  });

  it('does not count a lifetime message counter as currently usable snapshot coverage', async () => {
    const body = await getSnapshotAvailabilityBody();
    assert.match(body, /const hasData = Number\(snapshot\?\.status\?\.vessels\) > 0;/);
    assert.match(
      body,
      /if \(connected && snapshot\?\.status\?\.currentPositionReady === true && hasData\)/,
      'fresh availability must match the current-position readiness encoded in the served snapshot',
    );
    assert.doesNotMatch(body, /status\?\.messages/, 'old messages cannot keep an empty snapshot green forever');
  });
});
