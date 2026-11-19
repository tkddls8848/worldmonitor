// A chunk that fails on every load must cost at most one reload per
// build, never a reload loop. Each "page load" below imports a fresh instance of
// the guard module, because a real reload discards the JS heap: only what the
// browser storage kept survives.
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';


type GuardModule = typeof import('../src/bootstrap/chunk-reload');

interface FakeStorage {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
  removeItem: (key: string) => void;
}

function fakeStorage(): FakeStorage {
  const map = new Map<string, string>();
  return {
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

let loadCounter = 0;
async function freshGuardModule(): Promise<GuardModule> {
  loadCounter += 1;
  return import(`../src/bootstrap/chunk-reload.ts?page-load=${loadCounter}`) as Promise<GuardModule>;
}

/** Let the guard's post-dispatch microtask run. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
function setWindow(value: unknown): void {
  Object.defineProperty(globalThis, 'window', { configurable: true, value });
}
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

/**
 * One page load of `version` on which a chunk fails, with the guard reading
 * browser storage from `window` the way main.ts installs it. Returns whether
 * the page reloaded.
 */
async function pageLoadWithChunkFailure(version: string): Promise<boolean> {
  const { installChunkReloadGuard } = await freshGuardModule();
  const target = new EventTarget();
  let reloaded = false;
  installChunkReloadGuard(version, { eventTarget: target, reload: () => { reloaded = true; } });
  target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
  await settle();
  return reloaded;
}

async function countReloads(loads: number, version = 'build-A'): Promise<number> {
  let reloads = 0;
  for (let i = 0; i < loads; i += 1) {
    if (await pageLoadWithChunkFailure(version)) reloads += 1;
  }
  return reloads;
}

describe('chunk reload guard across page loads', () => {
  it('reloads once per build when the chunk fails on every load', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    assert.equal(await countReloads(5), 1);
  });

  it('gives a new build its own single reload', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    assert.equal(await countReloads(3, 'build-A'), 1);
    assert.equal(await countReloads(3, 'build-B'), 1);
  });

  it('falls back to localStorage when sessionStorage is null (Android WebView)', async () => {
    setWindow({ sessionStorage: null, localStorage: fakeStorage() });
    assert.equal(await countReloads(5), 1);
  });

  it('never reloads when no storage can keep the record across the reload', async () => {
    setWindow({ sessionStorage: null, localStorage: null });
    assert.equal(await countReloads(5), 0);
  });

  it('falls back when sessionStorage rejects writes', async () => {
    const readOnly: FakeStorage = {
      getItem: () => null,
      setItem: () => { throw new DOMException('quota', 'QuotaExceededError'); },
      removeItem: () => {},
    };
    setWindow({ sessionStorage: readOnly, localStorage: fakeStorage() });
    assert.equal(await countReloads(5), 1);
  });

  it('stands down when another listener claims the failure with preventDefault', async () => {
    setWindow({ sessionStorage: fakeStorage(), localStorage: fakeStorage() });
    const { installChunkReloadGuard } = await freshGuardModule();
    const target = new EventTarget();
    let reloads = 0;
    // Registered first, as main.ts registers it before any lazy loader runs.
    installChunkReloadGuard('build-A', { eventTarget: target, reload: () => { reloads += 1; } });
    target.addEventListener('vite:preloadError', (event) => event.preventDefault());
    target.dispatchEvent(new Event('vite:preloadError', { cancelable: true }));
    await settle();
    assert.equal(reloads, 0);
  });
});
