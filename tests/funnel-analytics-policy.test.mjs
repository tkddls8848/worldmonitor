/**
 * Conversion-funnel instrumentation policy (#4931).
 *
 * Source-extraction guards (same pattern as other policy tests): these
 * invariants are cheap to delete silently in a refactor and expensive to
 * notice — each one going missing blinds a segment of the funnel without
 * breaking any runtime behavior.
 *
 *  1. UMAMI_DOMAINS must list www.worldmonitor.app — the apex 301s to www in
 *     production and the Umami tracker's data-domains check is an EXACT
 *     hostname match; dropping www silently disables ALL dashboard analytics
 *     on the canonical host (the pre-#4931 state).
 *  2. The typed event catalog must contain the funnel events.
 *  3. startCheckout (dashboard) fires checkout-start; the checkout-return
 *     reconciliation fires checkout-success / checkout-failed.
 *
 * The /pro SPA and welcome landing (pro-test/) left this personal build, so
 * only the dashboard side of the /pro -> dashboard funnel handoff is pinned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const { trackApiAction } = await import('../src/services/analytics.ts');

test('UMAMI_DOMAINS covers the canonical www host', () => {
  const src = read('src/services/analytics.ts');
  const m = src.match(/const UMAMI_DOMAINS = '([^']+)'/);
  assert.ok(m, 'UMAMI_DOMAINS constant not found');
  const domains = m[1].split(',');
  assert.ok(domains.includes('www.worldmonitor.app'),
    'www.worldmonitor.app missing from UMAMI_DOMAINS — analytics dead on the canonical host');
  assert.ok(domains.includes('worldmonitor.app'),
    'apex worldmonitor.app missing from UMAMI_DOMAINS');
});

test('funnel events exist in the typed catalog', () => {
  const src = read('src/services/analytics.ts');
  for (const ev of ['checkout-start', 'checkout-success', 'checkout-failed', 'api-action', 'agent-connect']) {
    assert.ok(src.includes(`'${ev}': true`), `event '${ev}' missing from EVENTS catalog`);
  }
});

test('API outcome telemetry is bounded to successful key lifecycle actions', () => {
  const analytics = read('src/services/analytics.ts');
  const settings = read('src/components/UnifiedSettings.ts');
  assert.ok(analytics.includes("['key-created', 'key-revoked'] as const"),
    'API action vocabulary must stay closed to key lifecycle outcomes');
  assert.ok(analytics.includes("track('api-action', { action })"),
    'API action helper must emit only the normalized action bucket');
  assert.ok(settings.includes("trackApiAction('key-created')"),
    'successful API key creation no longer contributes to API outcomes');
  assert.ok(settings.includes("trackApiAction('key-revoked')"),
    'successful API key revocation no longer contributes to API outcomes');
  assert.ok(!settings.includes('trackApiAction(keyId)'),
    'API telemetry must not include a key identifier');
});

test('API outcome telemetry emits only the closed key lifecycle buckets at runtime', () => {
  const calls = [];
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      umami: {
        track: (event, data) => calls.push({ event, data }),
      },
    },
  });

  try {
    trackApiAction('key-created');
    trackApiAction('key-revoked');
    // The TypeScript signature protects typed callers; this exercises the
    // runtime boundary where an untyped or stale caller can still arrive.
    trackApiAction('key-exported');

    assert.deepEqual(calls, [
      { event: 'api-action', data: { action: 'key-created' } },
      { event: 'api-action', data: { action: 'key-revoked' } },
    ]);
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, 'window', previousWindow);
    } else {
      delete globalThis.window;
    }
  }
});

test('dashboard checkout entry fires checkout-start', () => {
  const src = read('src/services/checkout.ts');
  assert.match(
    src,
    /const checkoutContext = trackCheckoutStart\(\s*productId,\s*Boolean\(user\),/,
    'startCheckout no longer fires trackCheckoutStart or preserves its checkout context',
  );
});

test('checkout-return reconciliation fires success/failed events', () => {
  const src = read('src/app/panel-layout.ts');
  assert.ok(src.includes('trackCheckoutSuccess('),
    'checkout-return success path no longer fires trackCheckoutSuccess');
  assert.ok(src.includes('trackCheckoutFailed('),
    'checkout-return failed path no longer fires trackCheckoutFailed');
});

test('checkout-success is durable across the entitlement reload', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('sessionStorage.setItem(CHECKOUT_SUCCESS_PENDING_KEY'),
    'trackCheckoutSuccess no longer writes the durable marker');
  assert.ok(analytics.includes('clearPendingCheckoutSuccessMarker()'),
    'delivery-time marker clear missing from sendUmamiCall');
  const layout = read('src/app/panel-layout.ts');
  assert.ok(layout.includes('replayPendingCheckoutSuccess()'),
    'panel-layout boot no longer replays a pending checkout-success');
});

test('checkout-failed status is bucketed to a closed vocabulary', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('CHECKOUT_FAILED_STATUSES.has(rawStatus)'),
    'trackCheckoutFailed no longer normalizes the URL-derived status — unbounded cardinality');
});

test('checkout-start product ids are bucketed on the dashboard (round-4 F2)', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes('bucketProductIdForAnalytics(productId)'),
    'dashboard trackCheckoutStart no longer buckets the (resume-path URL-derived) productId');
  assert.ok(analytics.includes("from '@/config/product-ids.generated'") && analytics.includes('DODO_PRODUCT_IDS'),
    'dashboard product allowlist must keep deriving from the generated catalog');
});

test('/pro checkout-start survives the Dodo redirect via sessionStorage handoff (round-5)', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes("'wm-pro-funnel-pending'"),
    'dashboard replay no longer reads the /pro handoff key (keys must match across builds)');
  const layout = read('src/app/panel-layout.ts');
  assert.ok(layout.includes('replayPendingProFunnelEvents()'),
    'panel-layout boot no longer replays /pro funnel events');
});

test('/pro replay marker clears on DELIVERY, not on read (round-6)', () => {
  const analytics = read('src/services/analytics.ts');
  assert.ok(analytics.includes("call.data?.replayed === true"),
    'sendUmamiCall no longer clears the pro-funnel marker on confirmed replay delivery');
  assert.ok(analytics.includes('clearPendingProFunnelMarker()'),
    'delivery-time pro-funnel marker clear is missing');
  assert.ok(analytics.includes('JSON.stringify(sanitized.map'),
    'replay no longer rewrites the marker with sanitized survivors — a pre-delivery reload would retry raw junk or nothing');
});
