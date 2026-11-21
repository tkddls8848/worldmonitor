import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PanelLayoutManager } from '@/app/panel-layout';
import type { AppContext } from '@/app/app-context';
import type { Panel } from '@/components/Panel';
import type { PanelConfig } from '@/types';

const constructed = vi.hoisted(() => ({ count: 0 }));

vi.mock('@/components/LiveNewsPanel', () => {
  class LiveNewsPanel {
    private readonly el: HTMLElement;
    constructor() {
      constructed.count += 1;
      this.el = document.createElement('div');
      this.el.className = 'panel';
      this.el.dataset.panel = 'live-news';
    }
    getElement(): HTMLElement { return this.el; }
    show(): void { this.el.classList.remove('hidden'); }
    hide(): void { this.el.classList.add('hidden'); }
    toggle(visible: boolean): void { this.el.classList.toggle('hidden', !visible); }
    isCollapsed(): boolean { return false; }
    observeNearViewport(): void {}
    notifyConnected(): void {}
    destroy(): void {}
  }
  return {
    LiveNewsPanel,
    getDefaultLiveChannels: () => [{ id: 'fixture' }],
    loadChannelsFromStorage: () => [],
  };
});

function makeLayoutManager(settings: Record<string, PanelConfig>) {
  const ctx = {
    isMobile: false,
    isDestroyed: false,
    PANEL_ORDER_KEY: 'panel-order',
    panelSettings: settings,
    panels: {} as Record<string, Panel>,
    newsPanels: {},
    newsCategoryPanelKeys: new Map(),
    map: { resize: vi.fn() },
  } as unknown as AppContext;
  const manager = new PanelLayoutManager(ctx, {
    openCountryStory: vi.fn(),
    openCountryBrief: vi.fn(),
    openSearch: vi.fn(),
    loadAllData: vi.fn(async () => {}),
    primeVisiblePanelData: vi.fn(),
    updateMonitorResults: vi.fn(),
  });
  return { ctx, manager };
}

describe('LiveNewsPanel single construction (rereview2 B-M2)', () => {
  beforeEach(() => {
    constructed.count = 0;
    localStorage.clear();
    document.body.innerHTML = '<div id="panelsGrid" class="panels-grid"></div>';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('mid-session mount and tray open share one import, so only one LiveNewsPanel is constructed', async () => {
    const { ctx, manager } = makeLayoutManager({
      'live-news': { name: 'Live News', enabled: true, priority: 1 },
    });
    const mgrAny = manager as unknown as {
      ensurePanelElementForTray: (panelId: 'live-news') => Promise<HTMLElement | null>;
      importPanel: (key: string, ...rest: unknown[]) => Promise<Panel | null>;
      liveNewsLoadInFlight: Promise<Panel | null> | null;
    };
    // Two independent imports are the race: each factory can run before the other
    // caller assigns ctx.panels, and the loser was dropped without destroy().
    const importSpy = vi.spyOn(mgrAny, 'importPanel');
    try {
      // Channels appear mid-session, then the tray opens before the import resolves.
      manager.mountLiveNewsIfReady();
      expect(mgrAny.liveNewsLoadInFlight).not.toBeNull();
      const trayEl = await mgrAny.ensurePanelElementForTray('live-news');
      expect(importSpy.mock.calls.filter(([key]) => key === 'live-news')).toHaveLength(1);
      await vi.waitFor(() => {
        expect(ctx.panels['live-news']).toBeTruthy();
      });

      expect(constructed.count).toBe(1);
      expect(trayEl).toBe(ctx.panels['live-news']!.getElement());
      expect(document.querySelectorAll('[data-panel="live-news"]').length).toBe(1);

      // A later storage event is a no-op once the panel exists.
      manager.mountLiveNewsIfReady();
      await Promise.resolve();
      expect(constructed.count).toBe(1);
    } finally {
      manager.destroy();
    }
  });
});
