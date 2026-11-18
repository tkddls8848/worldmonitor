import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import ts from 'typescript';

import { PREMIUM_RPC_PATHS } from '../src/shared/premium-paths.ts';

// ---------------------------------------------------------------------------
// Why this test exists
// ---------------------------------------------------------------------------
//
// `premiumFetch` (src/services/premium-fetch.ts) only attaches the Clerk
// Bearer token when the target path is a member of `PREMIUM_RPC_PATHS`. A
// premium-gated direct-edge endpoint that's *missing* from that set silently
// breaks for browser Pro users who don't carry a tester key:
//
//   premiumFetch sees the path is "not premium" → skips Bearer injection →
//   request goes out unauthenticated → server's isCallerPremium returns
//   false → 403 "Pro subscription required" despite a valid subscription.
//
// That exact regression hit `/api/chat-analyst` (post-PR-#3797). The fix is
// trivial — add the path to PREMIUM_RPC_PATHS — but the trap is that it
// stays invisible until someone manages to call the endpoint AND has no
// tester key AND isn't on a desktop with WORLDMONITOR_API_KEY.
//
// This guard fails CI when a new file under `api/` gates on premium auth
// (via `isCallerPremium()` or returns the literal 403 body) but the
// corresponding route isn't covered by PREMIUM_RPC_PATHS or this file's
// allowlist.

// Gateway-level direct-LLM routes also require a Clerk identity before quota
// reservation. Browser callers must therefore enter through premiumFetch so
// they attach Bearer auth and so the wm-session interceptor does not mistake
// the expected anonymous 401 for a dead HttpOnly session. Summarize stays out:
// its translate mode is intentionally available to free callers and the
// gateway only applies direct-LLM quota after inspecting the request body.
//
// #5674 — an entry here is NOT sufficient on its own. Membership in
// PREMIUM_RPC_PATHS does two independent jobs: it tells premiumFetch to attach
// a Bearer, and it tells the wm-session interceptor that a 401 on this route is
// an expected auth denial rather than a rejected session cookie. This allowlist
// was originally justified against the FIRST job only, which left the second
// unhandled: every unauthenticated summarize call 401'd, the interceptor minted
// a fresh session, replayed, 401'd again, and suppressed ALL anonymous API
// calls for 15 minutes (#5219). Each entry must therefore also name the
// mechanism that keeps its 401s out of session recovery, and
// SESSION_RECOVERY_BYPASS_PROOF must assert that mechanism is actually wired.
const DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST: Record<string, string> = {
  '/api/news/v1/summarize-article':
    'The route also serves free translate mode — which REQUIRES the anonymous ' +
    'wms_ cookie, so the path cannot join PREMIUM_RPC_PATHS. Spend-bearing ' +
    'summarize calls opt into premiumFetch with forcePremium instead of gating ' +
    'the whole path, and session recovery is bypassed per-request via the ' +
    'premium-intent marker (src/services/premium-intent.ts).',
};

// The wiring each allowlisted route depends on to keep its expected 401s out of
// wm-session recovery. A rationale in a comment is not a guarantee — this is
// asserted structurally below.
const SESSION_RECOVERY_BYPASS_PROOF: Record<
  string,
  { file: string; premiumFetchCall: string; expectedPremiumFetchCalls: number; rpcMethod: string }
> = {
  '/api/news/v1/summarize-article': {
    file: 'src/services/summarization.ts',
    premiumFetchCall: 'forcePremium',
    // Pinned: see the count assertion below for why a bare "a marking call
    // exists" boolean is not a proof.
    expectedPremiumFetchCalls: 1,
    // The RPC the marked client must be the receiver of. This file calls the
    // same method on the PLAIN client for free translate mode, so the binding
    // is receiver-based, not method-name-based.
    rpcMethod: 'summarizeArticle',
  },
};

// ---------------------------------------------------------------------------
// Source scan
// ---------------------------------------------------------------------------

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
describe('premium-paths guard — browser direct-LLM routes cannot trigger wm-session recovery', () => {
  it('every session-recovery-bypass proof still points at a live allowlist entry', () => {
    for (const route of Object.keys(SESSION_RECOVERY_BYPASS_PROOF)) {
      assert.ok(
        DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST[route],
        `Stale SESSION_RECOVERY_BYPASS_PROOF entry ${route}: the route is no longer ` +
        `allowlisted, so either drop this proof or restore the allowlist rationale.`,
      );
    }
  });

  it('every direct-LLM bypass remains real and intentionally non-premium', () => {
    for (const route of Object.keys(DIRECT_LLM_PREMIUM_BYPASS_ALLOWLIST)) {
      assert.equal(
        PREMIUM_RPC_PATHS.has(route),
        false,
        `${route} is now premium-routed; remove its stale direct-LLM bypass.`,
      );
    }
  });

});
