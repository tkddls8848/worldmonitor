/**
 * Followed-countries client service — single owner of watchlist semantics.
 *
 * The list lives in localStorage at `wm-followed-countries-v1`, stored as
 * `JSON.stringify({ countries: string[] })`. There is no account and no
 * cloud copy, so there is no cap and no sign-in handoff.
 *
 * Patterns mirrored from:
 *  - src/services/market-watchlist.ts (event dispatch, JSON.parse safety)
 *  - src/services/aviation/watchlist.ts (storage-key versioning)
 *
 * `FollowMutationResult` is a discriminated union, never a `boolean | null`.
 */

import { toIso2 } from '../utils/country-codes';

// ---------------------------------------------------------------------------
// Public constants & types
// ---------------------------------------------------------------------------

/** localStorage key for the followed list. Versioned for safe migration. */
export const FOLLOWED_COUNTRIES_STORAGE_KEY = 'wm-followed-countries-v1';

/** Custom event name dispatched on every successful mutation. */
export const WM_FOLLOWED_COUNTRIES_CHANGED = 'wm-followed-countries-changed';

/**
 * Discriminated-union result. Service NEVER throws from
 * `addCountry` / `removeCountry`.
 */
export type FollowMutationResult =
  | { ok: true }
  | { ok: false; reason: 'DISABLED' }
  | { ok: false; reason: 'INVALID_INPUT' }
  | { ok: false; reason: 'STORAGE_FULL' };

export type ServiceEntitlementState = 'pro' | 'free' | 'loading';

declare global {
  interface Window {
    __wmFollowedCountries?: {
      getFollowed: () => string[];
    };
  }
}

// ---------------------------------------------------------------------------
// Test-injection seams
// ---------------------------------------------------------------------------
//
// Node's `node:test` runner has no first-class ESM module mocker, so the
// feature flag is overridable through a narrow setter. Production callers
// never touch it.

let _featureFlagOverride: boolean | null = null;

/** Test-only — override the feature flag (`null` restores the env read). */
export function _setDepsForTests(deps: { featureFlagEnabled?: boolean | null }): void {
  if (deps.featureFlagEnabled !== undefined) {
    _featureFlagOverride = deps.featureFlagEnabled;
  }
}

/** Test-only — clears all module-level state so tests start from a clean slate. */
export function _resetStateForTests(): void {
  _listenersInstalled = false;
  if (_crossTabStorageListener && typeof window !== 'undefined') {
    window.removeEventListener('storage', _crossTabStorageListener);
  }
  _crossTabStorageListener = null;
  if (typeof window !== 'undefined') {
    delete window.__wmFollowedCountries;
  }
}

/**
 * Cross-tab `storage` event listener. When Tab-A mutates
 * `wm-followed-countries-v1`, every other tab fires a `storage` event.
 * We re-dispatch as `WM_FOLLOWED_COUNTRIES_CHANGED` so FollowButton
 * subscribers in Tab-B re-render. Installed once via
 * `installFollowedCountriesListeners()`.
 */
let _crossTabStorageListener: ((ev: StorageEvent) => void) | null = null;

// ---------------------------------------------------------------------------
// Feature-flag gate
// ---------------------------------------------------------------------------

function isFeatureFlagEnabled(): boolean {
  if (_featureFlagOverride !== null) return _featureFlagOverride;
  // Default ON; OFF only when explicitly set to '0'.
  try {
    const flag = import.meta.env.VITE_FOLLOW_COUNTRIES_ENABLED;
    return flag !== '0';
  } catch {
    return true;
  }
}

/**
 * Public read-only mirror of the internal feature-flag check. Exposed so
 * UI helpers (e.g. FollowButton) gate on the same source of truth —
 * including the `_setDepsForTests({ featureFlagEnabled: ... })` override —
 * instead of duplicating the `import.meta.env` parse.
 */
export function isFollowFeatureEnabled(): boolean {
  return isFeatureFlagEnabled();
}

// ---------------------------------------------------------------------------
// Storage I/O
// ---------------------------------------------------------------------------

interface StoredShape {
  countries: string[];
}

/** Absent, non-JSON and wrong-shape values all read as an empty list. */
function readLocalStorageList(): string[] {
  let raw: string | null = null;
  try {
    raw = typeof localStorage !== 'undefined'
      ? localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY)
      : null;
  } catch {
    return [];
  }
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as Partial<StoredShape>).countries)
  ) {
    return [];
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of (parsed as StoredShape).countries) {
    if (typeof c !== 'string') continue;
    const norm = toIso2(c);
    if (!norm) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  return out;
}

/**
 * Returns `true` on success, `false` on storage quota / write failure.
 */
function writeLocalStorageList(list: string[]): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: list }),
    );
    return true;
  } catch {
    return false;
  }
}

function dispatchChanged(): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));
  } catch {
    // jsdom-less test envs may not have CustomEvent; swallow.
  }
}

// ---------------------------------------------------------------------------
// Entitlement
// ---------------------------------------------------------------------------

/** Every follow is allowed: there is no plan that limits it. */
export function serviceEntitlementState(): ServiceEntitlementState {
  return 'pro';
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------

let _listenersInstalled = false;

function installFollowedCountriesGlobal(): void {
  if (typeof window === 'undefined') return;
  window.__wmFollowedCountries = { getFollowed };
}

/**
 * Install the picker global and the cross-tab `storage` listener.
 * Idempotent. Called once from app boot.
 */
export function installFollowedCountriesListeners(): void {
  if (!isFollowFeatureEnabled()) return;
  installFollowedCountriesGlobal();
  if (_listenersInstalled) return;
  _listenersInstalled = true;
  _installCrossTabStorageListener();
}

/**
 * Re-dispatch `storage` events for our key as
 * `WM_FOLLOWED_COUNTRIES_CHANGED` so subscribers in other tabs
 * (FollowButton instances) re-render when this tab mutates the list.
 * The browser only fires `storage` in OTHER tabs; same-tab updates
 * already dispatch via `dispatchChanged()` from the write site.
 */
function _installCrossTabStorageListener(): void {
  if (_crossTabStorageListener) return;
  if (typeof window === 'undefined') return;
  const handler = (ev: StorageEvent): void => {
    if (ev.key !== FOLLOWED_COUNTRIES_STORAGE_KEY) return;
    dispatchChanged();
  };
  window.addEventListener('storage', handler);
  _crossTabStorageListener = handler;
}

/** Test-only — install the cross-tab storage listener in isolation. */
export function _installCrossTabStorageListenerForTests(): void {
  _installCrossTabStorageListener();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the current followed list as an ISO-2 array.
 *
 * Sync, never throws. Empty/corrupt storage → [].
 */
export function getFollowed(): string[] {
  return readLocalStorageList();
}

/** Sync `isFollowed` check; case-folds via `toIso2`. */
export function isFollowed(code: string): boolean {
  const norm = toIso2(code);
  if (!norm) return false;
  return getFollowed().includes(norm);
}

/**
 * Add a country to the followed list. Idempotent. Never throws —
 * returns a `FollowMutationResult` discriminated union.
 */
export async function addCountry(input: string): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  const existing = readLocalStorageList();
  if (existing.includes(code)) return { ok: true };
  const wrote = writeLocalStorageList([...existing, code]);
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };
  dispatchChanged();
  return { ok: true };
}

/**
 * Remove a country from the followed list. Idempotent — removing a
 * country that isn't in the list returns `{ok:true}`.
 */
export async function removeCountry(
  input: string,
): Promise<FollowMutationResult> {
  if (!isFeatureFlagEnabled()) return { ok: false, reason: 'DISABLED' };

  const code = toIso2(input);
  if (!code) return { ok: false, reason: 'INVALID_INPUT' };

  const existing = readLocalStorageList();
  if (!existing.includes(code)) return { ok: true };
  const wrote = writeLocalStorageList(existing.filter((c) => c !== code));
  if (!wrote) return { ok: false, reason: 'STORAGE_FULL' };
  dispatchChanged();
  return { ok: true };
}

/**
 * Subscribe to followed-list changes. Fires after every successful
 * `addCountry` / `removeCountry`, and when another tab changes the list.
 *
 * Returns an unsubscribe function.
 */
export function subscribe(handler: () => void): () => void {
  if (typeof window === 'undefined') {
    return () => {
      /* no-op in non-browser env */
    };
  }
  window.addEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  return () => {
    window.removeEventListener(WM_FOLLOWED_COUNTRIES_CHANGED, handler);
  };
}
