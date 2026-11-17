/**
 * #5622 — how the apex `/mcp-grant` consent page reacts to a handshake denial.
 *
 * The bug this pins: `api/internal/mcp-grant-{context,mint}` now answer an
 * unverifiable entitlement with a retryable 503 `TIER_VERIFICATION_UNAVAILABLE`,
 * but the page's error mapping was a `switch` with a terminal `default`. An
 * unknown code therefore rendered "could not be completed. Start over from your
 * MCP client." and destroyed the consent card — turning the one denial the user
 * could have simply clicked through into a dead end.
 *
 * The module under test is a zero-import leaf so it stays importable under
 * `tsx --test`: `src/mcp-grant-main.ts` boots Clerk and touches
 * window/localStorage at import time, which is why the decision was unreachable
 * from a test before it was extracted (same constraint as
 * tests/premium-denial.test.mts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyGrantDenial,
  grantClientDisplay,
  describeGrantDelay,
  grantErrorMessage,
  grantErrorTitle,
  MAX_INLINE_GRANT_WAIT_MS,
  retryableGrantDelayMs,
  routeGrantContextDenial,
  shouldWaitInline,
} from '../src/services/mcp-grant-denial.ts';

describe('grantErrorMessage', () => {
  it('gives the retryable code copy that invites another attempt', () => {
    const msg = grantErrorMessage('TIER_VERIFICATION_UNAVAILABLE');
    assert.match(msg, /temporary/i);
    assert.match(msg, /try again/i);
    assert.doesNotMatch(
      msg,
      /Start over from your MCP client/,
      'the nonce is still valid — sending the user back to their client wastes it',
    );
  });

  it('keeps the terminal codes terminal', () => {
    assert.match(grantErrorMessage('INVALID_NONCE'), /expired or is invalid/);
    assert.match(grantErrorMessage('INSUFFICIENT_TIER'), /Pro subscription is required/);
    assert.match(grantErrorMessage('UNKNOWN_CLIENT'), /no longer registered/);
    assert.match(grantErrorMessage('INVALID_REDIRECT_URI'), /not allowed/);
  });

  it('covers NONCE_CLAIMED_BY_OTHER_USER rather than falling through to the generic copy', () => {
    // The anti-hijack 403 (F2) existed before this module and was NOT in the
    // page's switch, so a victim saw generic copy for a security-relevant state.
    const msg = grantErrorMessage('NONCE_CLAIMED_BY_OTHER_USER');
    assert.match(msg, /another account/i);
    assert.notEqual(msg, grantErrorMessage('SOMETHING_ELSE'));
  });

  it('falls back for an unknown or absent code', () => {
    const fallback = grantErrorMessage(undefined);
    assert.match(fallback, /could not be completed/);
    assert.equal(grantErrorMessage('WHATEVER_NEW_CODE'), fallback);
    assert.equal(grantErrorMessage(''), fallback);
  });

  it('does not resolve inherited object properties as messages', () => {
    // `code` comes from a server JSON body, so a plain index lookup would return
    // Object.prototype members — a `code` of "toString" yielded a Function, which
    // renders as source text in the error view.
    for (const code of ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty']) {
      const msg = grantErrorMessage(code);
      assert.equal(typeof msg, 'string', `${code} must not resolve to a non-string`);
      assert.equal(msg, grantErrorMessage(undefined), `${code} must take the fallback`);
    }
  });
});

describe('grantErrorTitle', () => {
  /**
   * The page rendered ONE heading — "Authorization request expired" — above every
   * terminal body. Only `INVALID_NONCE` is actually an expiry, so the other six
   * disagreed with the text underneath them. The worst pair shipped on the flow
   * this change exists to improve.
   */
  it('does not call a Pro-subscription denial an expiry', () => {
    const title = grantErrorTitle('INSUFFICIENT_TIER');
    assert.equal(title, 'Pro subscription required');
    assert.doesNotMatch(
      title,
      /expired/i,
      'a caller without Pro was told their request expired, which points at the '
      + 'wrong remedy — restarting from the client cannot fix a missing subscription',
    );
  });

  it('does not disguise the anti-phishing and hijack refusals as an expiry', () => {
    // These two are security-relevant states; labelling them "expired" hides the
    // signal that something was actively refused.
    assert.doesNotMatch(grantErrorTitle('INVALID_REDIRECT_URI'), /expired/i);
    assert.doesNotMatch(grantErrorTitle('NONCE_CLAIMED_BY_OTHER_USER'), /expired/i);
  });

  it('reserves the expiry heading for the one code that is an expiry', () => {
    assert.equal(grantErrorTitle('INVALID_NONCE'), 'Authorization request expired');
    const expiryTitled = Object.keys({
      INVALID_NONCE: 0,
      UNKNOWN_CLIENT: 0,
      INVALID_REDIRECT_URI: 0,
      INSUFFICIENT_TIER: 0,
      NONCE_CLAIMED_BY_OTHER_USER: 0,
      CONFIGURATION_ERROR: 0,
      SERVICE_UNAVAILABLE: 0,
      TIER_VERIFICATION_UNAVAILABLE: 0,
    }).filter((code) => /expired/i.test(grantErrorTitle(code)));
    assert.deepEqual(expiryTitled, ['INVALID_NONCE']);
  });

  it('falls back without resolving inherited object properties', () => {
    const fallback = grantErrorTitle(undefined);
    assert.equal(fallback, 'Authorization failed');
    for (const code of ['constructor', 'toString', '__proto__', 'WHATEVER_NEW_CODE']) {
      assert.equal(typeof grantErrorTitle(code), 'string');
      assert.equal(grantErrorTitle(code), fallback);
    }
  });

  it('travels on the verdict so the heading and body cannot be sourced separately', () => {
    // Deriving both from the same code in one place is what stops them drifting.
    for (const code of ['INSUFFICIENT_TIER', 'INVALID_NONCE', 'TIER_VERIFICATION_UNAVAILABLE']) {
      const verdict = classifyGrantDenial(403, code);
      assert.equal(verdict.title, grantErrorTitle(code));
      assert.equal(verdict.message, grantErrorMessage(code));
    }
    assert.equal(classifyGrantDenial(401, 'UNAUTHENTICATED').title, grantErrorTitle('UNAUTHENTICATED'));
  });
});

describe('retryableGrantDelayMs', () => {
  it('honors the advertised delay', () => {
    assert.equal(retryableGrantDelayMs('5'), 5_000);
    assert.equal(retryableGrantDelayMs('1'), 1_000);
    assert.equal(retryableGrantDelayMs('22'), 22_000);
  });

  it('falls back to the server default for a missing or unusable header', () => {
    // RFC 9110 also permits an HTTP-date, which Number() makes NaN — the default
    // is the right answer there rather than re-enabling instantly.
    for (const header of [null, '', 'soon', '0', '-3', 'Wed, 21 Oct 2015 07:28:00 GMT']) {
      assert.equal(
        retryableGrantDelayMs(header),
        5_000,
        `Retry-After ${JSON.stringify(header)} must fall back to the 5s default`,
      );
    }
  });

  it('clamps to the server ceiling rather than disabling the button indefinitely', () => {
    assert.equal(retryableGrantDelayMs('60'), 60_000);
    assert.equal(retryableGrantDelayMs('3600'), 60_000);
  });

  it('never returns 0 — re-enabling instantly walks into the negative cache', () => {
    for (const header of [null, '0', '-1', '0.1', 'nonsense']) {
      assert.ok(
        retryableGrantDelayMs(header) > 0,
        `Retry-After ${JSON.stringify(header)} must still impose a wait`,
      );
    }
  });
});

describe('classifyGrantDenial', () => {
  it('#5622: the retryable entitlement code keeps the consent card', () => {
    assert.deepEqual(
      classifyGrantDenial(503, 'TIER_VERIFICATION_UNAVAILABLE').action,
      'retryable',
    );
  });

  it('a Redis transport 503 is retryable too — it always read that way, it just could not say so', () => {
    assert.equal(classifyGrantDenial(503, 'SERVICE_UNAVAILABLE').action, 'retryable');
  });

  it('a 401 is sign-in regardless of body, matching the page it replaced', () => {
    for (const code of [undefined, 'UNAUTHENTICATED', 'TIER_VERIFICATION_UNAVAILABLE']) {
      assert.equal(classifyGrantDenial(401, code).action, 'sign_in');
    }
  });

  it('every terminal code stays terminal', () => {
    for (const code of [
      'INVALID_NONCE',
      'UNKNOWN_CLIENT',
      'INVALID_REDIRECT_URI',
      'INSUFFICIENT_TIER',
      'NONCE_CLAIMED_BY_OTHER_USER',
      'CONFIGURATION_ERROR',
    ]) {
      assert.equal(
        classifyGrantDenial(403, code).action,
        'terminal',
        `${code} must not become a retry loop`,
      );
    }
  });

  it('a bare 503 with no readable code is terminal — an intermediary is not the handshake', () => {
    // Retrying on status alone would loop against a CDN/WAF page forever. The
    // retryable set is an explicit allowlist for exactly this reason.
    assert.equal(classifyGrantDenial(503, undefined).action, 'terminal');
    assert.equal(classifyGrantDenial(503, 'Bad Gateway').action, 'terminal');
  });

  it('a confirmed lapse is terminal even though it arrives on the same gate', () => {
    // The server keeps INSUFFICIENT_TIER for a provider-confirmed lapse; the page
    // must not retry it just because a X-Billing-Verification header is present.
    assert.equal(classifyGrantDenial(403, 'INSUFFICIENT_TIER').action, 'terminal');
  });

  it('the verdict always carries the message for the same code', () => {
    for (const [status, code] of [[503, 'TIER_VERIFICATION_UNAVAILABLE'], [403, 'INVALID_NONCE'], [401, undefined]] as const) {
      assert.equal(classifyGrantDenial(status, code).message, grantErrorMessage(code));
    }
  });
});

describe('routeGrantContextDenial', () => {
  it('spends exactly one automatic retry before exposing the manual retry action', () => {
    assert.equal(routeGrantContextDenial('retryable', 'idle', 1), 'retry');
    assert.equal(routeGrantContextDenial('retryable', 'idle', 0), 'show_retry');
  });

  it('preserves consent for a retryable Clerk context reload throughout the mint lifecycle', () => {
    assert.equal(
      routeGrantContextDenial('retryable', 'in_flight', 1),
      'preserve_consent',
    );
    assert.equal(
      routeGrantContextDenial('retryable', 'retry_cooldown', 0),
      'preserve_consent',
    );
  });

  it('keeps terminal and sign-in denials out of every retry path', () => {
    for (const phase of ['idle', 'in_flight', 'retry_cooldown'] as const) {
      assert.equal(routeGrantContextDenial('terminal', phase, 1), 'terminal');
      assert.equal(routeGrantContextDenial('sign_in', phase, 1), 'sign_in');
    }
  });
});

// ---------------------------------------------------------------------------
// Wiring: call-site COUNT pins only
// ---------------------------------------------------------------------------

/**
 * #5622 review — the inline-wait budget.
 *
 * The server may legitimately ask for a full minute: `renewal_verification_failed`
 * carries the per-subscription provider cooldown (`ON_DEMAND_RENEWAL_FAILURE_COOLDOWN_MS`
 * = 60s). Honoring that inline parks the consent page on a spinner, or leaves
 * Authorize dead on "Retry shortly…", for that whole minute. The sibling client
 * (src/services/notification-channels.ts) already declined to auto-wait past 10s
 * for the identical state; these pin the same judgment here.
 */
describe('inline-wait budget (#5622 review)', () => {
  it('waits out the short delays the retryable states actually ask for', () => {
    // entitlement_verification_unavailable: fixed 5s.
    assert.equal(shouldWaitInline(retryableGrantDelayMs('5')), true);
    // renewal_verification_pending: 1-3s from the Dodo re-check window.
    assert.equal(shouldWaitInline(retryableGrantDelayMs('1')), true);
    assert.equal(shouldWaitInline(retryableGrantDelayMs('3')), true);
    // The server's own default when the header is absent.
    assert.equal(shouldWaitInline(retryableGrantDelayMs(null)), true);
  });

  it('declines to block the page on the 60s renewal cooldown', () => {
    assert.equal(shouldWaitInline(retryableGrantDelayMs('60')), false);
    assert.equal(shouldWaitInline(retryableGrantDelayMs('30')), false);
    assert.equal(shouldWaitInline(retryableGrantDelayMs('11')), false);
  });

  it('accepts the boundary exactly, so the threshold is not off by one', () => {
    assert.equal(shouldWaitInline(MAX_INLINE_GRANT_WAIT_MS), true);
    assert.equal(shouldWaitInline(MAX_INLINE_GRANT_WAIT_MS + 1), false);
    assert.equal(shouldWaitInline(retryableGrantDelayMs('10')), true);
  });

  it('matches the sibling client budget, so the two cannot silently diverge', () => {
    // src/services/notification-channels.ts::BILLING_RETRY_MAX_DELAY_MS.
    assert.equal(MAX_INLINE_GRANT_WAIT_MS, 10_000);
  });

  it('names the wait in copy the user can act on', () => {
    assert.equal(describeGrantDelay(60_000), 'about 60 seconds');
    assert.equal(describeGrantDelay(5_000), 'about 5 seconds');
    assert.equal(describeGrantDelay(1_000), 'about 1 second');
    // Sub-second never rounds to "about 0 seconds".
    assert.equal(describeGrantDelay(200), 'about 1 second');
  });
});

// #9244 — a CIMD client's consent card adds the host that published its
// metadata document and warns when the authorization goes to localhost. A DCR
// context carries neither field and must render exactly as before.
describe('grantClientDisplay', () => {
  it('shows the client_id host and the localhost warning for a CIMD loopback flow', () => {
    assert.deepEqual(
      grantClientDisplay({ client_name: 'Claude Code', redirect_host: 'localhost', client_host: 'claude.ai', localhost_redirect: true }),
      { clientIdHost: 'claude.ai', showLocalhostWarning: true },
    );
  });

  it('shows the client_id host without a warning for a hosted CIMD callback', () => {
    assert.deepEqual(
      grantClientDisplay({ client_name: 'Linear', redirect_host: 'linear.app', client_host: 'linear.app', localhost_redirect: false }),
      { clientIdHost: 'linear.app', showLocalhostWarning: false },
    );
  });

  it('shows neither for a DCR context or malformed fields', () => {
    assert.deepEqual(grantClientDisplay({ client_name: 'Claude', redirect_host: 'claude.ai' }), { clientIdHost: null, showLocalhostWarning: false });
    assert.deepEqual(
      grantClientDisplay({ client_name: 'x', redirect_host: 'y', client_host: '', localhost_redirect: 'true' as unknown as boolean }),
      { clientIdHost: null, showLocalhostWarning: false },
    );
  });
});
