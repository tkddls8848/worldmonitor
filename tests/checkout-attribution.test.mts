/**
 * Checkout attribution end to end (plan 2026-08-30-001, U2).
 *
 * Contract under test:
 *  1. A checkout started from a mission preview records surface + missionId +
 *     panelKey both on the live `checkout-start` event and in the durable
 *     pending-conversion entry (sessionStorage), so the attribution survives
 *     the Dodo/sign-in redirect.
 *  2. `replayPendingConversionEvents` re-emits the stored event with the same
 *     attribution plus `replayed: true`.
 *  3. Existing non-mission checkouts are unchanged: `surface: 'dashboard'`,
 *     no mission fields.
 *  4. Attribution ids are bucketed — a crafted mission id collapses to
 *     'unknown' before it can reach Umami (same rule as productId).
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const PENDING_KEY = 'wm-conversion-pending';
const KNOWN_PRODUCT = 'pdt_0Nbtt71uObulf7fGXhQup';

describe('shared checkout attribution contract', () => {
  it('round-trips only registered preview mission and panel pairs', async () => {
    const attribution = await import('../shared/checkout-attribution.ts');
    const url = attribution.buildAttributedProUrl('https://worldmonitor.app/pro', {
      missionId: 'supply-chain-risk',
      panelKey: 'supply-chain',
    });
    assert.deepEqual(
      attribution.parseMissionPreviewAttributionFromSearch(new URL(url).search),
      { kind: 'mission-preview', missionId: 'supply-chain-risk', panelKey: 'supply-chain' },
    );
    assert.equal(
      attribution.parseMissionPreviewAttribution('supply-chain-risk', 'cii'),
      null,
    );
  });

  it('validates stored surfaces and migrates legacy attempts', async () => {
    const attribution = await import('../shared/checkout-attribution.ts');
    assert.equal(attribution.parseCheckoutContext({
      eventSurface: 'crafted',
      origin: { kind: 'dashboard' },
    }), null);

    const migrated = attribution.parseCheckoutAttemptRecord({
      productId: KNOWN_PRODUCT,
      startedAt: Date.now(),
      missionId: 'osint-newsroom',
      panelKey: 'gdelt-intel',
      analyticsSurface: 'crafted',
    });
    assert.equal(migrated?.context.eventSurface, 'dashboard');
    assert.deepEqual(migrated?.context.origin, {
      kind: 'mission-preview',
      missionId: 'osint-newsroom',
      panelKey: 'gdelt-intel',
    });
  });
});

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

type TrackedCall = { name: string; data?: Record<string, unknown> };

function installWindow(): { calls: TrackedCall[]; sessionStorage: MemoryStorage } {
  const calls: TrackedCall[] = [];
  const sessionStorage = new MemoryStorage();
  const localStorage = new MemoryStorage();
  const fakeWindow: Record<string, unknown> = {
    sessionStorage,
    localStorage,
    innerWidth: 1280,
    umami: {
      track: (name: string, data?: Record<string, unknown>) => calls.push({ name, data }),
      identify: () => {},
    },
  };
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: localStorage });
  return { calls, sessionStorage };
}

function cleanupWindow(): void {
  delete (globalThis as { window?: unknown }).window;
  delete (globalThis as { localStorage?: unknown }).localStorage;
}

function readPending(storage: MemoryStorage): Array<{ event: string; data: Record<string, unknown> }> {
  const raw = storage.getItem(PENDING_KEY);
  return raw ? JSON.parse(raw) : [];
}
