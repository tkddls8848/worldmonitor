import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { loadTabsState, saveTabsState, type TabsState } from '../src/services/tab-store.ts';

type GlobalSnapshot = { exists: boolean; value: unknown };

function snapshotGlobal(name: string): GlobalSnapshot {
  return {
    exists: Object.prototype.hasOwnProperty.call(globalThis, name),
    value: (globalThis as Record<string, unknown>)[name],
  };
}

function restoreGlobal(name: string, snapshot: GlobalSnapshot): void {
  if (snapshot.exists) {
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value: snapshot.value,
    });
    return;
  }
  delete (globalThis as Record<string, unknown>)[name];
}

class MemoryStorage {
  private readonly store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

class ThrowingStorage extends MemoryStorage {
  override setItem(_key: string, _value: string): void {
    throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
  }
}

const localStorageSnapshot = snapshotGlobal('localStorage');

const sample: TabsState = {
  activeTabId: 'tab-main01-abc123',
  tabs: [{
    id: 'tab-main01-abc123',
    name: 'Main',
    panelSettings: {},
    panelOrder: [],
    bottomSet: [],
  }],
};

afterEach(() => {
  restoreGlobal('localStorage', localStorageSnapshot);
});

describe('loadTabsState', () => {
  it('prunes the retired panel from a saved tab while keeping a custom widget', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new MemoryStorage(),
    });
    const tab = sample.tabs[0]!;
    const widget = { name: 'Custom widget', enabled: true, priority: 2 };
    const settings = {
      'cw-example': widget,
      'toronto-safety': widget,
      'live-webcams': widget,
      'positive-feed': widget,
      'windy-webcams': widget,
      'live-youtube': widget,
      'pinned-webcams': widget,
    };
    const order = Object.keys(settings);
    saveTabsState({ ...sample, tabs: [{ ...tab, panelSettings: settings, panelOrder: order, bottomSet: order, panelFilters: { 'live-webcams': 'europe', forecast: 'asia' } }] });
    assert.deepEqual(loadTabsState(), {
      ...sample,
      tabs: [{ ...tab, panelSettings: { 'cw-example': widget }, panelOrder: ['cw-example'], bottomSet: ['cw-example'], panelFilters: { forecast: 'asia' } }],
    });
  });
});

describe('saveTabsState persist receipt', () => {
  it('returns persisted: true when localStorage accepts the write', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new MemoryStorage(),
    });
    assert.deepEqual(saveTabsState(sample), { persisted: true });
  });

  it('returns persisted: false when localStorage.setItem throws', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      writable: true,
      value: new ThrowingStorage(),
    });
    assert.deepEqual(saveTabsState(sample), { persisted: false });
  });
});
