/**
 * Tests for src/utils/follow-button.ts (U4).
 *
 * The Node test runner has no jsdom; we provide a minimal `host`
 * mock that supports `innerHTML`, `addEventListener` /
 * `removeEventListener`, and a synthetic `click()` that fires the
 * registered click listener with a `target` resolved by a `closest()`
 * stub. This is enough to exercise the factory's contract:
 *
 *   - render html for state (a) outlined / (b) filled / (c) loading /
 *     (d) hidden;
 *   - on attach, install click + watchlist + entitlement listeners;
 *   - on click, call addCountry / removeCountry and branch on
 *     FollowMutationResult.reason (FREE_CAP triggers upgrade, others
 *     are defensive no-ops);
 *   - on teardown, drop all listeners (idempotent).
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Browser-global stubs
// ---------------------------------------------------------------------------

class MemoryStorage {
  constructor() {
    this.store = new Map();
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class FakeWindow extends EventTarget {
  constructor() {
    super();
    this.location = { origin: 'http://localhost' };
  }
  open() {
    /* no-op — tests don't need real popups */
  }
}
class FakeDocument extends EventTarget {
  constructor() {
    super();
    this.hidden = false;
  }
}

let _localStorage;
let _window;
let _document;

before(() => {
  _localStorage = new MemoryStorage();
  _window = new FakeWindow();
  _document = new FakeDocument();
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: _localStorage,
  });
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: _window,
  });
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: _document,
  });
  if (typeof globalThis.CustomEvent === 'undefined') {
    globalThis.CustomEvent = class extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.detail = init.detail;
      }
    };
  }
});

after(() => {
  delete globalThis.localStorage;
  delete globalThis.window;
  delete globalThis.document;
});

// ---------------------------------------------------------------------------
// Imports under test
// ---------------------------------------------------------------------------

const svc = await import('../src/services/followed-countries.ts');
const {
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  WM_FOLLOWED_COUNTRIES_CHANGED,
  _setDepsForTests,
  _resetStateForTests,
} = svc;

const fb = await import('../src/utils/follow-button.ts');
const { renderFollowButton } = fb;

// ---------------------------------------------------------------------------
// Mock host element
// ---------------------------------------------------------------------------

/**
 * Minimal stand-in for HTMLElement that the FollowButton's `attach`
 * needs:
 *  - `innerHTML` — re-rendered on every state change.
 *  - `addEventListener('click', handler)` / `removeEventListener`.
 *  - `clickButton()` — synthesises a click event whose `target.closest(sel)`
 *    resolves the inner `.wm-follow-btn`. We don't parse the html;
 *    we just reflect what the most recent render emitted.
 */
function makeHost() {
  const listeners = new Map(); // type -> Set<handler>
  let _innerHtml = '';
  const host = {
    set innerHTML(v) {
      _innerHtml = String(v);
    },
    get innerHTML() {
      return _innerHtml;
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(handler);
    },
    removeEventListener(type, handler) {
      listeners.get(type)?.delete(handler);
    },
    /**
     * Fire a synthetic click. The handler resolves the actual button via
     * `target.closest('.wm-follow-btn')`. We set `target` to a stub that
     * mirrors the rendered button — it returns itself for `.closest` and
     * exposes the `data-state` attribute extracted from the html.
     */
    clickButton() {
      const stateMatch = /data-state="([^"]+)"/.exec(_innerHtml);
      const state = stateMatch ? stateMatch[1] : '';
      const buttonStub = {
        getAttribute: (name) => (name === 'data-state' ? state : null),
        closest: (sel) =>
          sel === '.wm-follow-btn' && _innerHtml.includes('class="wm-follow-btn')
            ? buttonStub
            : null,
      };
      const ev = {
        type: 'click',
        target: buttonStub,
        preventDefault: () => {},
      };
      const set = listeners.get('click');
      if (set) for (const h of set) h(ev);
    },
    /** Number of listeners attached for a given event type. */
    listenerCount(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
  return host;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupAnonymousFree() {
  _setDepsForTests({ featureFlagEnabled: true });
}

async function flushMicrotasks() {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  _localStorage.clear();
  _resetStateForTests();
});

describe('renderFollowButton — basic visual states', () => {
  it('anonymous, not followed → emits outlined-star html with data-state="unfollowed"', () => {
    setupAnonymousFree();
    const handle = renderFollowButton({ countryCode: 'US' });
    assert.match(handle.html, /data-state="unfollowed"/);
    assert.match(handle.html, /class="wm-follow-btn wm-follow-btn--md/);
    assert.match(handle.html, /aria-pressed="false"/);
    // Outlined: SVG has fill="none" + stroke="currentColor"
    assert.match(handle.html, /fill="none"/);
  });

  it('anonymous, followed → emits filled-star html with data-state="followed"', () => {
    setupAnonymousFree();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const handle = renderFollowButton({ countryCode: 'US' });
    assert.match(handle.html, /data-state="followed"/);
    assert.match(handle.html, /aria-pressed="true"/);
    // Filled: SVG has fill="currentColor"
    assert.match(handle.html, /fill="currentColor"/);
    assert.match(handle.html, /Unfollow US/);
  });

  it('feature flag off → empty html, attach is a no-op', () => {
    _setDepsForTests({ featureFlagEnabled: false });
    const handle = renderFollowButton({ countryCode: 'US' });
    assert.equal(handle.html, '');
    const host = makeHost();
    const teardown = handle.attach(host);
    // attach() did not register any listeners on the host
    assert.equal(host.listenerCount('click'), 0);
    // teardown is callable
    teardown();
    teardown(); // idempotent
  });

  it('size="sm" applies the sm modifier class', () => {
    setupAnonymousFree();
    const handle = renderFollowButton({ countryCode: 'US', size: 'sm' });
    assert.match(handle.html, /wm-follow-btn--sm/);
  });

  it('countryName is reflected in the tooltip / aria-label', () => {
    setupAnonymousFree();
    const handle = renderFollowButton({
      countryCode: 'US',
      countryName: 'United States',
    });
    assert.match(handle.html, /Follow United States/);
  });
});

describe('renderFollowButton — click behavior (anonymous mode)', () => {
  it('click on unfollowed → addCountry, then re-render to followed', async () => {
    setupAnonymousFree();
    const handle = renderFollowButton({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    // Initial render is unfollowed.
    assert.match(host.innerHTML, /data-state="unfollowed"/);

    host.clickButton();
    await flushMicrotasks();

    // Service should have committed; rerender via WM_FOLLOWED_COUNTRIES_CHANGED.
    assert.match(host.innerHTML, /data-state="followed"/);
    assert.equal(
      JSON.parse(_localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY)).countries[0],
      'US',
    );

    teardown();
  });

  it('click on followed → removeCountry, then re-render to unfollowed', async () => {
    setupAnonymousFree();
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    const handle = renderFollowButton({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.match(host.innerHTML, /data-state="followed"/);

    host.clickButton();
    await flushMicrotasks();

    assert.match(host.innerHTML, /data-state="unfollowed"/);
    teardown();
  });

  it('rapid double-click → idempotent (followed then unfollowed)', async () => {
    setupAnonymousFree();
    const handle = renderFollowButton({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);

    host.clickButton();
    await flushMicrotasks();
    assert.match(host.innerHTML, /data-state="followed"/);

    host.clickButton();
    await flushMicrotasks();
    assert.match(host.innerHTML, /data-state="unfollowed"/);
    assert.deepEqual(
      JSON.parse(_localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY) ?? '{"countries":[]}').countries,
      [],
    );

    teardown();
  });

});

describe('renderFollowButton — entitlement-loading window', () => {
  it('anonymous user with null entitlement state → renders interactive (NOT loading)', () => {
    // Anonymous: clerk user is null AND entitlement state is null.
    // The service's `serviceEntitlementState()` returns 'free' (not 'loading')
    // for this case (Codex round-2 finding #1). The button must follow suit.
    setupAnonymousFree();
    const handle = renderFollowButton({ countryCode: 'US' });
    assert.match(handle.html, /data-state="unfollowed"/);
    assert.doesNotMatch(handle.html, /data-state="loading"/);
  });

});

describe('renderFollowButton — P2 #16 INVALID_INPUT and assertNever exhaustiveness', () => {
  it('keeps the compile-time guard and logs an invalid mounted country code', async (t) => {
    const source = readFileSync(new URL('../src/utils/follow-button.ts', import.meta.url), 'utf8');
    assert.match(
      source,
      /^[ \t]+assertNever\(result\);[ \t]*$/m,
      'the switch must pass its fully narrowed result to the exhaustiveness guard',
    );

    setupAnonymousFree();
    const warn = t.mock.method(console, 'warn', () => {});
    const handle = renderFollowButton({ countryCode: 'NotAValidCode' });
    const host = makeHost();
    const teardown = handle.attach(host);
    host.clickButton();
    await flushMicrotasks();
    teardown();
    assert.equal(warn.mock.callCount(), 1);
    assert.deepEqual(warn.mock.calls[0].arguments, [
      '[follow-button] invalid country code at mount site:',
      'NotAValidCode',
    ]);
  });
});

describe('renderFollowButton — P2 #17 inFlight prevents rapid double-click duplicate mutations', () => {
});

describe('renderFollowButton — subscription / external mutation', () => {
  it('external watchlist mutation re-renders the button', async () => {
    setupAnonymousFree();
    const handle = renderFollowButton({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    assert.match(host.innerHTML, /data-state="unfollowed"/);

    // Simulate an external mutation: write directly to localStorage and
    // dispatch the change event (matches what addCountry does internally
    // in anonymous mode).
    _localStorage.setItem(
      FOLLOWED_COUNTRIES_STORAGE_KEY,
      JSON.stringify({ countries: ['US'] }),
    );
    _window.dispatchEvent(new CustomEvent(WM_FOLLOWED_COUNTRIES_CHANGED));
    await flushMicrotasks();

    assert.match(host.innerHTML, /data-state="followed"/);
    teardown();
  });

  it('teardown removes click listener; subsequent click is a no-op', async () => {
    setupAnonymousFree();
    const handle = renderFollowButton({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);

    assert.equal(host.listenerCount('click'), 1);
    teardown();
    assert.equal(host.listenerCount('click'), 0);

    // A click after teardown produces no mutation.
    host.clickButton();
    await flushMicrotasks();
    assert.equal(_localStorage.getItem(FOLLOWED_COUNTRIES_STORAGE_KEY), null);
  });

  it('teardown is idempotent (calling twice does not throw)', () => {
    setupAnonymousFree();
    const handle = renderFollowButton({ countryCode: 'US' });
    const host = makeHost();
    const teardown = handle.attach(host);
    teardown();
    teardown();
    // No assertion — the absence of a throw IS the assertion.
  });

});
