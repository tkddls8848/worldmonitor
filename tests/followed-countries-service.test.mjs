/**
 * Tests for src/services/followed-countries.ts in the personal build, where
 * the followed list lives only in this browser's localStorage.
 *
 * Test runner: node:test via `tsx --test tests/*.test.mjs`.
 */

import { describe, it, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.store = new Map();
    this.throwOnSet = false;
  }
  getItem(key) {
    return this.store.has(key) ? this.store.get(key) : null;
  }
  setItem(key, value) {
    if (this.throwOnSet) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    this.store.set(key, String(value));
  }
  removeItem(key) {
    this.store.delete(key);
  }
  clear() {
    this.store.clear();
  }
}

class FakeWindow extends EventTarget {}

let _localStorage;
let _window;

before(() => {
  _localStorage = new MemoryStorage();
  _window = new FakeWindow();
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: _localStorage });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: _window });
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
});

const svc = await import('../src/services/followed-countries.ts');
const {
  addCountry,
  removeCountry,
  getFollowed,
  isFollowed,
  subscribe,
  serviceEntitlementState,
  FOLLOWED_COUNTRIES_STORAGE_KEY,
  _setDepsForTests,
  _resetStateForTests,
} = svc;

beforeEach(() => {
  _localStorage.clear();
  _localStorage.throwOnSet = false;
  _resetStateForTests();
  _setDepsForTests({ featureFlagEnabled: true });
});

describe('followed countries (local only)', () => {
  it('starts empty and reads corrupt storage as empty', () => {
    assert.deepEqual(getFollowed(), []);
    _localStorage.setItem(FOLLOWED_COUNTRIES_STORAGE_KEY, '{not json');
    assert.deepEqual(getFollowed(), []);
  });

  it('adds, normalizes and de-duplicates countries', async () => {
    assert.deepEqual(await addCountry('us'), { ok: true });
    assert.deepEqual(await addCountry('US'), { ok: true });
    assert.deepEqual(getFollowed(), ['US']);
    assert.equal(isFollowed('us'), true);
  });

  it('rejects input that is not a country', async () => {
    assert.deepEqual(await addCountry('not-a-country'), { ok: false, reason: 'INVALID_INPUT' });
    assert.deepEqual(getFollowed(), []);
  });

  it('removes idempotently', async () => {
    await addCountry('FR');
    assert.deepEqual(await removeCountry('fr'), { ok: true });
    assert.deepEqual(await removeCountry('fr'), { ok: true });
    assert.deepEqual(getFollowed(), []);
  });

  it('reports a full storage instead of throwing', async () => {
    _localStorage.throwOnSet = true;
    assert.deepEqual(await addCountry('DE'), { ok: false, reason: 'STORAGE_FULL' });
  });

  it('refuses mutations while the feature flag is off', async () => {
    _setDepsForTests({ featureFlagEnabled: false });
    assert.deepEqual(await addCountry('JP'), { ok: false, reason: 'DISABLED' });
  });

  it('notifies subscribers after a change, and stops after unsubscribe', async () => {
    let calls = 0;
    const off = subscribe(() => { calls += 1; });
    await addCountry('BR');
    assert.equal(calls, 1);
    off();
    await removeCountry('BR');
    assert.equal(calls, 1);
  });

  it('has no follow cap: the personal build is always pro', async () => {
    assert.equal(serviceEntitlementState(), 'pro');
    for (const code of ['US', 'CA', 'MX', 'BR', 'AR', 'GB', 'FR', 'DE', 'IT', 'ES']) {
      assert.deepEqual(await addCountry(code), { ok: true });
    }
    assert.equal(getFollowed().length, 10);
  });
});
