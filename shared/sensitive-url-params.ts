/**
 * The one list of URL params that must never reach a telemetry vendor:
 * checkout/provisioning secrets, the Business Pro invite, referral and
 * discount codes (including the /pro `wm_checkout_ref`/`wm_checkout_discount`
 * return-URL pair),
 * Clerk handshake/ticket material, checkout-funnel codes, and the desktop
 * checkout handoff's account fingerprint (a pseudonymous account id), and the
 * satellite pass share link (`orbital`, a place on the globe). Vercel
 * Analytics (secondary-startup.ts) and Umami (analytics.ts) redact these per
 * event. DebugBear RUM reads `location` directly and has no redaction hook,
 * so it waits until none of them is left in the live URL (debugbear-rum.ts).
 *
 * Most of these keys have a deferred reader (referral capture, checkout
 * intent capture, the invite acceptor, the Clerk SDK), so they cannot be
 * stripped from the live URL at boot. STRIPPABLE_AT_BOOT_RE is the subset
 * nobody reads.
 */
export const SENSITIVE_URL_PARAM_RE = /^(token|access_token|id_token|refresh_token|auth_token|invite_token|accept-business-invite|email|user_email|customer_email|license_key|licensekey|subscription_id|payment_id|ref|wm_referral|checkoutproduct|checkoutreferral|checkoutdiscount|checkout_product|checkout_referral|checkout_discount|wm_checkout_account|wm_checkout_ref|wm_checkout_discount|__clerk[a-z_]*|affonso_referral|discount|coupon|promo|voucher|orbital)$/i;

/**
 * Params safe to strip from the live URL at boot: read by nobody.
 * handleCheckoutReturn() only DELETES email/license_key (never branches on
 * them). `__clerk*` is deliberately NOT here: @clerk/clerk-js loads late
 * (scheduleClerkLoad defers it to requestIdleCallback) and reads
 * `__clerk_status` / `__clerk_created_session` / `__clerk_ticket` straight
 * off window.location.href, so stripping them at boot breaks email-link and
 * ticket sign-in in production.
 */
export const STRIPPABLE_AT_BOOT_RE = /^(email|license_key|licensekey)$/i;

/** Delete every key matching `pattern`; true when anything was removed. */
export function scrubParams(params: URLSearchParams, pattern: RegExp): boolean {
  let changed = false;
  for (const key of [...params.keys()]) {
    if (pattern.test(key)) {
      params.delete(key);
      changed = true;
    }
  }
  return changed;
}

/** Scrub key=value pairs from a hash fragment, covering both `#head?k=v` and
 * OAuth-style `#k=v&k2=v2` shapes. Returns the scrubbed fragment (without the
 * leading #), or null when nothing matched. `pattern` is the caller's list:
 * the boot strip uses a much narrower one than the analytics redaction. */
export function scrubHashFragment(fragment: string, pattern: RegExp): string | null {
  const qIndex = fragment.indexOf('?');
  if (qIndex >= 0) {
    const head = fragment.slice(0, qIndex);
    const hashParams = new URLSearchParams(fragment.slice(qIndex + 1));
    if (!scrubParams(hashParams, pattern)) return null;
    const rebuilt = hashParams.toString();
    return rebuilt ? `${head}?${rebuilt}` : head;
  }
  if (!fragment.includes('=') && !fragment.includes('&')) {
    return pattern.test(fragment) ? '' : null;
  }
  const hashParams = new URLSearchParams(fragment);
  return scrubParams(hashParams, pattern) ? hashParams.toString() : null;
}

/** Scrub `pattern` keys from a parsed URL's query and fragment in place. */
export function scrubUrl(parsed: URL, pattern: RegExp): boolean {
  let changed = scrubParams(parsed.searchParams, pattern);
  if (parsed.hash) {
    const scrubbed = scrubHashFragment(parsed.hash.slice(1), pattern);
    if (scrubbed !== null) {
      parsed.hash = scrubbed ? `#${scrubbed}` : '';
      changed = true;
    }
  }
  return changed;
}

/**
 * A point looked up on the globe goes only to the image archives the browser
 * calls, and those request URLs carry it as a bounding-box parameter or as
 * comma-separated numbers in the path (a crop box, a point read). The page's
 * own `#orbital=<lat>,<lon>` route carries it in the fragment. Telemetry keeps
 * the rest of the URL and loses those parts.
 */
export const COORDINATE_URL_PARAM_RE = /^(bbox|intersects|orbital)$/i;
const COORDINATE_NUMBER = String.raw`[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[-+]?\d+)?`;
const COORDINATE_PATH_SEGMENT_RE = new RegExp(`^${COORDINATE_NUMBER}(?:,${COORDINATE_NUMBER}){1,3}(?:\\.[a-z]+)?$`, 'i');
export const REDACTED_COORDINATES = 'redacted';

/** Remove coordinate params and coordinate path segments from a parsed URL in place. */
export function scrubCoordinates(parsed: URL): boolean {
  let changed = scrubUrl(parsed, COORDINATE_URL_PARAM_RE);
  const segments = parsed.pathname.split('/');
  const scrubbedPath = segments.map((segment) => (COORDINATE_PATH_SEGMENT_RE.test(segment) ? REDACTED_COORDINATES : segment)).join('/');
  if (scrubbedPath !== parsed.pathname) {
    parsed.pathname = scrubbedPath;
    changed = true;
  }
  return changed;
}

/**
 * Remove every sensitive key and every coordinate from `raw`. Returns `raw` itself when nothing
 * matched or it cannot be parsed, so callers can test identity. A relative
 * input resolves against `base` and comes back relative, keeping the same
 * shape as an unredacted value.
 */
export function redactSensitiveUrl(raw: string, base?: string): string {
  if (raw.length === 0) return raw;
  const wasAbsolute = /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//');
  let parsed: URL;
  try {
    parsed = base ? new URL(raw, base) : new URL(raw);
  } catch {
    return raw;
  }
  const scrubbed = scrubUrl(parsed, SENSITIVE_URL_PARAM_RE);
  if (!scrubCoordinates(parsed) && !scrubbed) return raw;
  const redacted = parsed.toString();
  if (wasAbsolute || !base) return redacted;
  const origin = parsed.origin;
  return redacted.startsWith(origin) ? redacted.slice(origin.length) || '/' : redacted;
}

/** True when `href` still carries any key from the shared sensitive list, in
 * the query string or the fragment. Unparseable or missing input is clean. */
export function urlCarriesSensitiveParams(href: unknown): boolean {
  if (typeof href !== 'string' || href.length === 0) return false;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return false;
  }
  for (const key of parsed.searchParams.keys()) {
    if (SENSITIVE_URL_PARAM_RE.test(key) || COORDINATE_URL_PARAM_RE.test(key)) return true;
  }
  const fragment = parsed.hash.slice(1);
  return fragment.length > 0
    && (scrubHashFragment(fragment, SENSITIVE_URL_PARAM_RE) !== null || scrubHashFragment(fragment, COORDINATE_URL_PARAM_RE) !== null);
}

/** How often and how long a URL-reading vendor waits for the deferred
 * consumers (referral/checkout capture after App.init, the invite acceptor
 * after sign-in, the Clerk SDK) to remove their params. */
export const SENSITIVE_URL_RECHECK_MS = 500;
export const SENSITIVE_URL_MAX_WAIT_MS = 20_000;

/**
 * Run `onClean` once `readHref()` no longer carries a sensitive param, or
 * `onGiveUp` if it still does after SENSITIVE_URL_MAX_WAIT_MS. For vendors
 * such as DebugBear RUM that read `location` themselves with no redaction
 * hook: the only way to keep a param out of them is to not load them yet.
 */
export function whenUrlFreeOfSensitiveParams(
  readHref: () => unknown,
  onClean: () => void,
  onGiveUp: () => void,
): void {
  let waited = 0;
  const check = (): void => {
    if (!urlCarriesSensitiveParams(readHref())) {
      onClean();
      return;
    }
    if (waited >= SENSITIVE_URL_MAX_WAIT_MS) {
      onGiveUp();
      return;
    }
    waited += SENSITIVE_URL_RECHECK_MS;
    setTimeout(check, SENSITIVE_URL_RECHECK_MS);
  };
  check();
}
