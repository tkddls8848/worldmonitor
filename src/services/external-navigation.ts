/**
 * "Send the user to this URL, outside the app".
 *
 * Browsers only honour `window.open()` inside a live user gesture, so a caller
 * may reserve a blank tab synchronously in its click handler
 * (`prereserveExternalTab`) and pass the handle here to be navigated once the
 * async work resolves.
 *
 * The URL-scheme gate (`isOpenableExternalUrl`) accepts `https://` only (plus
 * `http://` for localhost). It is exported so callers that cancel a click
 * before delegating — the anchor interceptor in `app/event-handlers.ts` — can
 * gate on the SAME predicate; a looser gate there turns every URL this module
 * refuses into a dead click.
 *
 * NOTE for anyone touching a `window.open` here: this module deliberately does
 * NOT pass `noopener`/`noreferrer`, because either one makes `window.open`
 * return null while still opening the tab, and every branch below reads that
 * handle to decide what happened. `openWindowWithHandle` severs `opener`
 * manually instead. See its comment before changing a feature string.
 */

/** https anywhere, http only for localhost. */
export function isOpenableExternalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:'
      && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

/**
 * `window.open` that actually yields a handle.
 *
 * `noopener` — and `noreferrer`, which implies it — makes `window.open`
 * return `null` PER SPEC while still opening the tab. Every caller here
 * branches on the handle, so passing those features turned each success into
 * an apparent blocked popup: `prereserveExternalTab` never returned a tab,
 * and the open path
 * ran its same-tab `assign` on top of a tab it had just opened. Measured in
 * Chrome: `window.open(url, '_blank', 'noopener,noreferrer')` is `null` with
 * the tab present in the tab list.
 *
 * The opener link is severed manually instead, which is the only thing those
 * features were bought for here — every URL routed through this module is
 * first-party-initiated and scheme-gated above. The referrer degrades from
 * absent to origin-only, which is the platform default
 * (`strict-origin-when-cross-origin`) for cross-origin targets.
 */
function openWindowWithHandle(url: string): Window | null {
  // `window.open` does not always merely RETURN null when refused: Chrome
  // Mobile iOS / WebKit can throw SecurityError (DOMException 18) instead —
  // notably once the user-gesture window is spent, which is exactly the state
  // this module reaches after awaiting a portal-session round-trip. A throw
  // here escapes every caller, including the fresh-open fallback the reserved
  // tab drops into, so normalize refusal to the null this function already
  // documents as its "did it open?" answer.
  let win: Window | null;
  try {
    win = window.open(url, '_blank');
  } catch {
    return null;
  }
  if (win) {
    try {
      win.opener = null;
    } catch {
      // Cross-origin setter refused (older engines). The tab still opened,
      // and the handle is still the answer to "did it open?".
    }
  }
  return win;
}

/**
 * `Window.closed` can itself throw SecurityError on Chrome Mobile iOS /
 * WKWebView after `window.open('', '_blank')`. Treat that as "unusable".
 */
function isWindowStillOpen(win: Window): boolean {
  try {
    return !win.closed;
  } catch {
    return false;
  }
}

/**
 * Close a reserved blank tab without letting SecurityError escape. Used when
 * the handle cannot be navigated (scheme reject, or a
 * thrown `location.href` assignment — WORLDMONITOR-11C).
 */
function closeWindowQuietly(win: Window | null | undefined): void {
  if (!win) return;
  try {
    win.close();
  } catch {
    // Blank-tab close can throw the same SecurityError as navigating it.
  }
}

/**
 * Reserve a blank tab SYNCHRONOUSLY inside a click handler so an async
 * external navigation can land in it without tripping the popup blocker.
 * Callers must call this before awaiting anything, then pass the handle to
 * `openExternalUrl`.
 */
export function prereserveExternalTab(): Window | null {
  return openWindowWithHandle('');
}

/**
 * Where the URL actually went. Callers that tell the user something happened
 * ("checkout opened in your browser") must branch on this rather than assume
 * success — a swallowed failure claiming success is worse than no message.
 */
export type ExternalNavOutcome = 'popup' | 'same-tab' | 'failed';

export interface OpenExternalUrlOptions {
  /**
   * Whether a blocked popup may fall back to navigating the CURRENT tab.
   *
   * Default `true`: for an upgrade CTA, losing the dashboard beats a dead
   * click. Pass `false` from any surface holding unsaved user input — the
   * runtime-config panels stage API keys in memory (`pendingSecrets`), and a
   * same-tab navigation discards them silently. Those callers get `'failed'`
   * and can surface it themselves.
   */
  sameTabFallback?: boolean;
}

export async function openExternalUrl(
  url: string | URL,
  preopened?: Window | null,
  options?: OpenExternalUrlOptions,
): Promise<ExternalNavOutcome> {
  const targetUrl = typeof url === 'string' ? url : url.toString();
  if (!isOpenableExternalUrl(targetUrl)) {
    closeWindowQuietly(preopened);
    return 'failed';
  }

  if (preopened) {
    try {
      if (isWindowStillOpen(preopened)) {
        preopened.location.href = targetUrl;
        return 'popup';
      }
    } catch {
      // Chrome Mobile iOS / WKWebView: assigning href on a blank tab reserved
      // via window.open('') throws SecurityError (DOMException 18). Fall
      // through to a fresh open / same-tab assign so a normal https portal
      // URL never rejects (WORLDMONITOR-11C).
    }
    // Close whenever we did not navigate the reserved handle — including
    // when `.closed` itself threw (isWindowStillOpen returns false and the
    // try above does not catch). An orphaned blank tab plus same-tab
    // fallback is the WORLDMONITOR-11C user-visible failure mode.
    closeWindowQuietly(preopened);
  }
  const fresh = openWindowWithHandle(targetUrl);
  if (fresh) return 'popup';
  // Genuinely blocked, and no reserved tab. Same-tab navigation beats
  // silently doing nothing for an upgrade CTA — but not for a caller holding
  // unsaved input, which opts out and gets the failure instead.
  if (options?.sameTabFallback === false) {
    return 'failed';
  }
  try {
    window.location.assign(targetUrl);
    return 'same-tab';
  } catch {
    return 'failed';
  }
}
