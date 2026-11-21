import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchSelectionDispatcher } from '@/app/search-selection-dispatcher';
import { applyAgentBusAction } from '@/app/agent-bus-applier';
import { InspectorShell } from '@/components/InspectorShell';
import { bindLayerSearch, MAP_LAYER_PRESETS, getLayersForVariant } from '@/config/map-layer-definitions';
import { EventHandlerManager } from '@/app/event-handlers';
import { PanelLayoutManager } from '@/app/panel-layout';
import type { AppContext } from '@/app/app-context';
import type { Panel } from '@/components/Panel';
import type { MapLayers, PanelConfig } from '@/types';

function makeFakePanel(id: string): Panel {
  const el = document.createElement('div');
  el.className = 'panel';
  el.dataset.panel = id;
  el.scrollIntoView = vi.fn();
  return {
    getElement: () => el,
    show: () => { el.classList.remove('hidden'); },
    hide: () => { el.classList.add('hidden'); },
    toggle: (visible: boolean) => { el.classList.toggle('hidden', !visible); },
    notifyConnected: vi.fn(),
    destroy: vi.fn(),
  } as unknown as Panel;
}

describe('Option B integration: search, agent reveal, legacy migration, tools menu, layer presets', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    document.documentElement.lang = 'ko';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('SearchSelectionDispatcher reveals hidden-tab and deferred panels via wm:reveal-panel and reports false if still hidden', async () => {
    document.body.innerHTML = '<div id="panelsGrid"></div>';
    const grid = document.getElementById('panelsGrid')!;

    const settings: Record<string, PanelConfig> = {
      insights: { name: 'AI Insights', enabled: true, priority: 1 },
      'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 2 },
      polymarket: { name: 'Predictions', enabled: true, priority: 2 },
    };

    const gdeltEl = document.createElement('div');
    gdeltEl.className = 'panel';
    gdeltEl.dataset.panel = 'gdelt-intel';
    gdeltEl.scrollIntoView = vi.fn();
    grid.appendChild(gdeltEl);

    // Deferred shell for polymarket
    const polyShell = document.createElement('div');
    polyShell.className = 'panel panel-deferred-shell';
    polyShell.dataset.panel = 'polymarket';
    polyShell.dataset.deferredPanel = 'true';
    polyShell.scrollIntoView = vi.fn();
    grid.appendChild(polyShell);

    const shell = new InspectorShell({
      getPanelSettings: () => settings,
      onTogglePanelEnabled: vi.fn(),
      onRevealPanel: vi.fn(),
      onTabChanged: vi.fn(),
      onOpenSettings: vi.fn(),
      onToggleCollapse: vi.fn(),
    });
    document.body.prepend(shell.getElement());
    shell.applyGridFilter();

    expect(gdeltEl.classList.contains('inspector-tab-hidden')).toBe(true);
    expect(polyShell.classList.contains('inspector-tab-hidden')).toBe(true);

    // Simulate PanelLayoutManager mounting a deferred panel on wm:reveal-panel
    const revealMountHandler = (e: Event) => {
      const panelId = (e as CustomEvent<{ panelId?: string }>).detail?.panelId;
      if (panelId === 'polymarket' && polyShell.isConnected) {
        const real = document.createElement('div');
        real.className = 'panel';
        real.dataset.panel = 'polymarket';
        real.scrollIntoView = vi.fn();
        polyShell.replaceWith(real);
        shell.applyToElement(real);
      }
    };
    window.addEventListener('wm:reveal-panel', revealMountHandler);

    const dispatcher = new SearchSelectionDispatcher({
      ctx: { panelSettings: settings, mapLayers: {} as MapLayers } as unknown as AppContext,
      getVariant: () => 'full',
      openCountryBriefByCode: () => true,
      enablePanel: () => true,
      resolveExecutableNewsPanel: () => null,
      saveToStorage: vi.fn(),
      setTheme: vi.fn(),
      setTimeout: (cb, ms) => globalThis.setTimeout(cb, ms),
      clearTimeout: (t) => globalThis.clearTimeout(t),
    });

    try {
      // 1. Mounted panel on another tab switches tab and succeeds
      const okMounted = await dispatcher.handleCommand({
        id: 'panel:gdelt-intel',
        label: 'Live Intelligence',
        category: 'panels',
        keywords: ['gdelt', 'intel', 'security'],
      });
      expect(okMounted).toBe(true);
      expect(shell.getActiveTab()).toBe('security');
      expect(gdeltEl.classList.contains('inspector-tab-hidden')).toBe(false);
      expect(gdeltEl.scrollIntoView).toHaveBeenCalled();

      // 2. Deferred panel on Markets tab switches tab, mounts, and succeeds
      const okDeferred = await dispatcher.handleCommand({
        id: 'panel:polymarket',
        label: 'Predictions',
        category: 'panels',
        keywords: ['predictions', 'polymarket', 'markets'],
      });
      expect(okDeferred).toBe(true);
      expect(shell.getActiveTab()).toBe('markets');
      expect(grid.querySelector('[data-panel="polymarket"]:not([data-deferred-panel])')).toBeTruthy();

      // 3. If a panel remains hidden (e.g. mobile-cat-hidden), dispatcher reports false
      gdeltEl.classList.add('mobile-cat-hidden');
      const hiddenResult = await dispatcher.handleCommand({
        id: 'panel:gdelt-intel',
        label: 'Live Intelligence',
        category: 'panels',
        keywords: ['gdelt', 'intel', 'security'],
      });
      expect(hiddenResult).toBe(false);
    } finally {
      window.removeEventListener('wm:reveal-panel', revealMountHandler);
      dispatcher.destroy();
      shell.destroy();
    }
  });

  it('agent-bus open_panel reveals hidden-tab panels via wm:reveal-panel and denies if still hidden', () => {
    document.body.innerHTML = '<div id="panelsGrid"></div>';
    const grid = document.getElementById('panelsGrid')!;
    const settings: Record<string, PanelConfig> = {
      insights: { name: 'AI Insights', enabled: true, priority: 1 },
      'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 2 },
    };
    const gdelt = makeFakePanel('gdelt-intel');
    grid.appendChild(gdelt.getElement());

    const shell = new InspectorShell({
      getPanelSettings: () => settings,
      onTogglePanelEnabled: vi.fn(),
      onRevealPanel: vi.fn(),
      onTabChanged: vi.fn(),
      onOpenSettings: vi.fn(),
      onToggleCollapse: vi.fn(),
    });
    document.body.prepend(shell.getElement());
    shell.applyGridFilter();
    expect(gdelt.getElement().classList.contains('inspector-tab-hidden')).toBe(true);

    const ctx = {
      panelSettings: settings,
      panels: { 'gdelt-intel': gdelt },
      mapLayers: {} as MapLayers,
    } as unknown as AppContext;

    const ok = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'gdelt-intel' });
    expect(ok.ok).toBe(true);
    expect(shell.getActiveTab()).toBe('security');
    expect(gdelt.getElement().classList.contains('inspector-tab-hidden')).toBe(false);

    // If still hidden (e.g., mobile-cat-hidden), agent reports denied instead of lying
    gdelt.getElement().classList.add('mobile-cat-hidden');
    const denied = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'gdelt-intel' });
    expect(denied.ok).toBe(false);
    expect(denied.reason).toBe('panel_hidden');

    shell.destroy();
  });

  it('migrates legacy bottom-set panels into #panelsGrid and respects Overview filter with legacy live-news-first panel-order', () => {
    document.body.innerHTML = `
      <div id="mapSection"></div>
      <div id="mapBottomGrid"><div class="panel" data-panel="markets"></div></div>
      <div id="panelsGrid"></div>
    `;
    const grid = document.getElementById('panelsGrid')!;
    const bottomGrid = document.getElementById('mapBottomGrid')!;

    const settings: Record<string, PanelConfig> = {
      'live-news': { name: 'Live News', enabled: true, priority: 1 },
      'live-webcams': { name: 'Live Webcams', enabled: true, priority: 1 },
      insights: { name: 'AI Insights', enabled: true, priority: 1 },
      markets: { name: 'Markets', enabled: true, priority: 1 },
    };
    localStorage.setItem('panel-order', JSON.stringify(['live-news', 'live-webcams', 'insights', 'markets']));
    localStorage.setItem('panel-order-bottom-set', JSON.stringify(['markets']));

    const ctx = {
      isMobile: false,
      isDestroyed: false,
      PANEL_ORDER_KEY: 'panel-order',
      panelSettings: settings,
      panels: {},
      newsPanels: {},
      newsCategoryPanelKeys: new Map(),
    } as unknown as AppContext;
    const manager = new PanelLayoutManager(ctx, {
      openCountryStory: vi.fn(),
      openCountryBrief: vi.fn(),
      openSearch: vi.fn(),
      loadAllData: vi.fn(async () => {}),
      primeVisiblePanelData: vi.fn(),
      updateMonitorResults: vi.fn(),
    });

    // Initial visible set filters out live-news/live-webcams on Overview even when legacy order puts them first
    const mgrAny = manager as unknown as {
      computeInitialVisiblePanelSet: () => Set<string> | null;
      initialVisiblePanelSet: Set<string> | null;
      shouldMountPanelImmediately: (key: string) => boolean;
      resolvedPanelOrder: string[];
    };
    mgrAny.initialVisiblePanelSet = mgrAny.computeInitialVisiblePanelSet();
    expect(mgrAny.shouldMountPanelImmediately('live-news')).toBe(false);
    expect(mgrAny.shouldMountPanelImmediately('live-webcams')).toBe(false);
    expect(mgrAny.shouldMountPanelImmediately('insights')).toBe(true);
    expect(mgrAny.shouldMountPanelImmediately('markets')).toBe(true);

    // ensureCorrectZones migrates any panel out of #mapBottomGrid back into #panelsGrid
    mgrAny.resolvedPanelOrder = ['insights', 'markets'];
    manager.ensureCorrectZones();
    expect(bottomGrid.querySelectorAll('.panel').length).toBe(0);
    expect(grid.querySelector('[data-panel="markets"]')).toBeTruthy();

    manager.destroy();
  });

  it('header tools menu toggles, closes on outside click/Escape, and cleans up document listeners on destroy', () => {
    document.body.innerHTML = `
      <div class="header-tools-wrap">
        <button id="headerToolsBtn" aria-expanded="false"></button>
        <div id="headerToolsPopover" hidden>
          <button id="headerAnalystBtn"></button>
          <span id="headerPlaybackSlot"></span>
          <span id="headerExportSlot"></span>
          <span id="headerPizzIntSlot"></span>
        </div>
      </div>
      <div id="outsideTarget"></div>
    `;

    const manager = new EventHandlerManager(
      { isMobile: false, isDestroyed: false, panels: {}, panelSettings: {}, mapLayers: {} as MapLayers } as unknown as AppContext,
      {} as never,
    );
    (manager as unknown as { setupHeaderToolsMenu: () => void }).setupHeaderToolsMenu();

    const btn = document.getElementById('headerToolsBtn')!;
    const popover = document.getElementById('headerToolsPopover')!;
    expect(popover.getAttribute('data-reload-policy')).toBe('safe');

    // Toggle open
    btn.click();
    expect(popover.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    // Outside click closes
    document.getElementById('outsideTarget')!.click();
    expect(popover.hidden).toBe(true);

    // Escape closes
    btn.click();
    expect(popover.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover.hidden).toBe(true);

    // destroy removes document listeners
    btn.click();
    expect(popover.hidden).toBe(false);
    manager.destroy();
    document.getElementById('outsideTarget')!.click();
    expect(popover.hidden).toBe(false);
  });

  it('bindLayerSearch expands collapsed layer groups on query match and presets obey variant filtering', () => {
    const container = document.createElement('div');
    container.innerHTML = `
      <input class="layer-search" type="search" />
      <details class="layer-group">
        <summary>Infra</summary>
        <div class="layer-toggle-row"><label class="layer-toggle" data-layer="cables">Undersea Cables</label></div>
      </details>
      <details class="layer-group">
        <summary>Security</summary>
        <div class="layer-toggle-row"><label class="layer-toggle" data-layer="conflicts">Conflicts</label></div>
      </details>
    `;
    document.body.appendChild(container);

    bindLayerSearch(container);
    const input = container.querySelector<HTMLInputElement>('.layer-search')!;
    const [infraGroup, secGroup] = Array.from(container.querySelectorAll<HTMLDetailsElement>('details.layer-group'));

    input.value = 'cables';
    input.dispatchEvent(new Event('input'));
    expect(infraGroup!.open).toBe(true);
    expect(infraGroup!.style.display).toBe('');
    expect(secGroup!.style.display).toBe('none');

    // Verify preset layer filtering against variant allowed layers
    const techAllowed = new Set(getLayersForVariant('tech', 'deck').map((d) => d.key));
    const corePreset = MAP_LAYER_PRESETS.find((p) => p.id === 'core')!;
    const effective = corePreset.layers.filter((k) => techAllowed.has(k));
    expect(effective.length).toBeGreaterThan(0);
    expect(effective.every((k) => techAllowed.has(k))).toBe(true);
  });
});
