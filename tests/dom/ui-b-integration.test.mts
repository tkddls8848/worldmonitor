import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchSelectionDispatcher } from '@/app/search-selection-dispatcher';
import { applyAgentBusAction } from '@/app/agent-bus-applier';
import { InspectorShell } from '@/components/InspectorShell';
import { BottomMediaTray } from '@/components/BottomMediaTray';
import {
  bindLayerSearch,
  MAP_LAYER_PRESETS,
  sanitizeLayersForVariant,
} from '@/config/map-layer-definitions';
import { EventHandlerManager } from '@/app/event-handlers';
import { PanelLayoutManager } from '@/app/panel-layout';
import type { AppContext } from '@/app/app-context';
import type { Panel } from '@/components/Panel';
import type { MapLayers, PanelConfig } from '@/types';
import { DEFAULT_MAP_LAYERS } from '@/config/panels';

function makeFakePanel(id: string): Panel {
  const el = document.createElement('div');
  el.className = 'panel';
  el.dataset.panel = id;
  const header = document.createElement('div');
  header.className = 'panel-header';
  const title = document.createElement('span');
  title.className = 'panel-title';
  title.textContent = id;
  header.appendChild(title);
  el.appendChild(header);
  el.scrollIntoView = vi.fn();
  return {
    getElement: () => el,
    show: () => { el.classList.remove('hidden'); },
    hide: () => { el.classList.add('hidden'); },
    toggle: (visible: boolean) => { el.classList.toggle('hidden', !visible); },
    isCollapsed: () => false,
    isFullscreenActive: () => false,
    supportsCollapse: () => true,
    supportsFullscreen: () => false,
    observeNearViewport: vi.fn(),
    notifyConnected: vi.fn(),
    destroy: vi.fn(),
  } as unknown as Panel;
}

function makeLayoutManager(settings: Record<string, PanelConfig>, panels: Record<string, Panel> = {}) {
  const ctx = {
    isMobile: false,
    isDestroyed: false,
    PANEL_ORDER_KEY: 'panel-order',
    panelSettings: settings,
    panels,
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

describe('Option B integration: real PanelLayoutManager reveal, tray race, bottom-zone retirement, tools menu', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '';
    document.documentElement.lang = 'ko';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
    delete document.documentElement.dataset.inspectorCollapsed;
    delete document.documentElement.dataset.inspectorWideGrid;
    delete document.documentElement.dataset.mapSide;
  });

  it('SearchSelectionDispatcher reveals hidden-tab, collapsed, and deferred panels through real PanelLayoutManager', async () => {
    document.body.innerHTML = `
      <main id="main" class="main-content inspector-collapsed">
        <div id="mapSection"></div>
        <div id="mapBottomGrid"></div>
        <section id="inspectorColumn">
          <div id="inspectorHeaderMount"></div>
          <div id="panelsGrid" class="panels-grid"></div>
        </section>
        <button id="inspectorReopenBtn"></button>
      </main>
    `;
    const grid = document.getElementById('panelsGrid')!;

    const settings: Record<string, PanelConfig> = {
      insights: { name: 'AI Insights', enabled: true, priority: 1 },
      'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 2 },
      polymarket: { name: 'Predictions', enabled: true, priority: 2 },
    };

    const gdeltPanel = makeFakePanel('gdelt-intel');
    const polyPanel = makeFakePanel('polymarket');
    const { ctx, manager } = makeLayoutManager(settings, { 'gdelt-intel': gdeltPanel });

    grid.appendChild(gdeltPanel.getElement());

    // Register real deferred panel through PanelLayoutManager.deferPanelMount
    const mgrAny = manager as unknown as {
      inspectorCollapsed: boolean;
      initialVisiblePanelSet: Set<string> | null;
      computeInitialVisiblePanelSet: () => Set<string> | null;
      installRevealPanelListener: () => void;
      mountInspectorShell: (ctor: typeof InspectorShell) => void;
      deferPanelMount: (key: string, panel: Panel | null, grid: HTMLElement, enabled: boolean) => void;
      inspectorShell: InspectorShell | null;
    };
    mgrAny.inspectorCollapsed = true;
    mgrAny.initialVisiblePanelSet = mgrAny.computeInitialVisiblePanelSet();
    mgrAny.deferPanelMount('polymarket', polyPanel, grid, true);
    mgrAny.installRevealPanelListener();
    mgrAny.mountInspectorShell(InspectorShell);

    expect(gdeltPanel.getElement().classList.contains('inspector-tab-hidden')).toBe(true);
    expect(grid.querySelector('[data-panel="polymarket"][data-deferred-panel="true"]')).toBeTruthy();

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
      // 1. Mounted hidden-tab panel uncollapses inspector, switches tab, and scrolls
      const okMounted = await dispatcher.handleCommand({
        id: 'panel:gdelt-intel',
        label: 'Live Intelligence',
        category: 'panels',
        keywords: ['gdelt', 'intel', 'security'],
      });
      expect(okMounted).toBe(true);
      expect(mgrAny.inspectorCollapsed).toBe(false);
      expect(document.getElementById('main')!.classList.contains('inspector-collapsed')).toBe(false);
      expect(mgrAny.inspectorShell!.getActiveTab()).toBe('security');
      expect(gdeltPanel.getElement().classList.contains('inspector-tab-hidden')).toBe(false);
      expect(gdeltPanel.getElement().scrollIntoView).toHaveBeenCalled();

      // 2. Deferred panel on Markets tab mounts via real mountDeferredPanel and becomes visible
      const okDeferred = await dispatcher.handleCommand({
        id: 'panel:polymarket',
        label: 'Predictions',
        category: 'panels',
        keywords: ['predictions', 'polymarket', 'markets'],
      });
      expect(okDeferred).toBe(true);
      expect(mgrAny.inspectorShell!.getActiveTab()).toBe('markets');
      expect(grid.querySelector('[data-panel="polymarket"][data-deferred-panel]')).toBeNull();
      expect(grid.contains(polyPanel.getElement())).toBe(true);
      expect(polyPanel.getElement().isConnected).toBe(true);
      expect(polyPanel.getElement().classList.contains('inspector-tab-hidden')).toBe(false);
      expect(polyPanel.observeNearViewport).toHaveBeenCalled();

      // 3. Panel still hidden by another filter reports false
      gdeltPanel.getElement().classList.add('mobile-cat-hidden');
      const hiddenResult = await dispatcher.handleCommand({
        id: 'panel:gdelt-intel',
        label: 'Live Intelligence',
        category: 'panels',
        keywords: ['gdelt', 'intel', 'security'],
      });
      expect(hiddenResult).toBe(false);
    } finally {
      dispatcher.destroy();
      manager.destroy();
    }
  });

  it('preserves a pre-shell wm:reveal-panel across mountInspectorShell (B-M2)', () => {
    document.body.innerHTML = `
      <div id="inspectorHeaderMount"></div>
      <div id="panelsGrid" class="panels-grid"></div>
    `;
    const grid = document.getElementById('panelsGrid')!;
    const settings: Record<string, PanelConfig> = {
      insights: { name: 'AI Insights', enabled: true, priority: 1 },
      'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 2 },
    };
    const gdelt = makeFakePanel('gdelt-intel');
    gdelt.getElement().classList.add('inspector-tab-hidden');
    grid.appendChild(gdelt.getElement());

    const { manager } = makeLayoutManager(settings, { 'gdelt-intel': gdelt });
    const mgrAny = manager as unknown as {
      initialVisiblePanelSet: Set<string> | null;
      computeInitialVisiblePanelSet: () => Set<string> | null;
      installRevealPanelListener: () => void;
      mountInspectorShell: (ctor: typeof InspectorShell) => void;
      inspectorShell: InspectorShell | null;
    };
    mgrAny.initialVisiblePanelSet = mgrAny.computeInitialVisiblePanelSet();
    mgrAny.installRevealPanelListener();

    // Reveal fires BEFORE InspectorShell chunk resolves
    window.dispatchEvent(new CustomEvent('wm:reveal-panel', { detail: { panelId: 'gdelt-intel' } }));
    expect(gdelt.getElement().classList.contains('inspector-tab-hidden')).toBe(false);

    // When InspectorShell subsequently mounts, it honors the pending reveal instead of re-hiding it
    mgrAny.mountInspectorShell(InspectorShell);
    expect(mgrAny.inspectorShell!.getActiveTab()).toBe('security');
    expect(gdelt.getElement().classList.contains('inspector-tab-hidden')).toBe(false);

    manager.destroy();
  });

  it('mountInspectorShell does not cancel pending BottomMediaTray load (B-I1) and fallbackWithoutInspector respects destroy (B-M9, B-I2)', async () => {
    document.body.innerHTML = `
      <div class="dashboard-navigation-row dashboard-navigation-row--hosted">
        <div id="panelTabsMount"></div>
      </div>
      <main id="main" class="main-content">
        <div id="inspectorHeaderMount"></div>
        <div id="panelsGrid" class="panels-grid">
          <div class="panel inspector-tab-hidden" data-panel="gdelt-intel"></div>
        </div>
      </main>
      <div id="bottomTrayMount"></div>
    `;
    const settings: Record<string, PanelConfig> = {
      insights: { name: 'AI Insights', enabled: true, priority: 1 },
      'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 2 },
    };

    const rafQueue: FrameRequestCallback[] = [];
    const origRaf = globalThis.requestAnimationFrame;
    const origCancelRaf = globalThis.cancelAnimationFrame;
    let nextRafId = 1;
    globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
      rafQueue.push(cb);
      return nextRafId++;
    }) as typeof requestAnimationFrame;
    globalThis.cancelAnimationFrame = vi.fn();

    const { ctx, manager } = makeLayoutManager(settings);
    const mgrAny = manager as unknown as {
      loadBottomTrayAsync: () => void;
      mountInspectorShell: (ctor: typeof InspectorShell) => void;
      fallbackWithoutInspector: () => void;
      bottomMediaTray: BottomMediaTray | null;
      panelTabBar: { destroy: () => void } | null;
    };

    try {
      // Schedule tray first (as renderLayout does), then resolve InspectorShell before rAF fires
      mgrAny.loadBottomTrayAsync();
      expect(rafQueue.length).toBe(1);

      mgrAny.mountInspectorShell(InspectorShell);
      expect(globalThis.cancelAnimationFrame).not.toHaveBeenCalled();

      // Flush scheduled rAF + setTimeout(0) + dynamic import
      rafQueue.shift()!(16);
      await vi.waitFor(() => {
        expect(document.getElementById('bottomTrayMount')!.querySelector('#bottomTrayWideGridBtn')).toBeTruthy();
      }, { timeout: 5000 });
      expect(mgrAny.bottomMediaTray).toBeTruthy();

      // Verify fallbackWithoutInspector unhides nav-row and panels when shell fails
      mgrAny.panelTabBar = { destroy: vi.fn() };
      mgrAny.fallbackWithoutInspector();
      expect(document.querySelector('.dashboard-navigation-row')!.classList.contains('dashboard-navigation-row--hosted')).toBe(false);
      expect(document.querySelector('[data-panel="gdelt-intel"]')!.classList.contains('inspector-tab-hidden')).toBe(false);

      // After destroy(), fallbackWithoutInspector is a no-op (B-M9)
      const hiddenEl = document.querySelector<HTMLElement>('[data-panel="gdelt-intel"]')!;
      hiddenEl.classList.add('inspector-tab-hidden');
      ctx.isDestroyed = true;
      manager.destroy();
      mgrAny.fallbackWithoutInspector();
      expect(hiddenEl.classList.contains('inspector-tab-hidden')).toBe(true);
    } finally {
      globalThis.requestAnimationFrame = origRaf;
      globalThis.cancelAnimationFrame = origCancelRaf;
      if (!ctx.isDestroyed) manager.destroy();
    }
  });

  it('agent-bus open_panel reveals via real PanelLayoutManager and never changes view on denied actions (B-M7)', () => {
    document.body.innerHTML = `
      <div id="inspectorHeaderMount"></div>
      <div id="panelsGrid" class="panels-grid"></div>
    `;
    const grid = document.getElementById('panelsGrid')!;
    const settings: Record<string, PanelConfig> = {
      insights: { name: 'AI Insights', enabled: true, priority: 1 },
      'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 2 },
      'supply-chain': { name: 'Supply Chain', enabled: true, priority: 2 },
      crypto: { name: 'Crypto', enabled: false, priority: 3 },
    };
    const gdelt = makeFakePanel('gdelt-intel');
    const supply = makeFakePanel('supply-chain');
    grid.append(gdelt.getElement(), supply.getElement());

    const { ctx, manager } = makeLayoutManager(settings, {
      'gdelt-intel': gdelt,
      'supply-chain': supply,
    });
    const mgrAny = manager as unknown as {
      installRevealPanelListener: () => void;
      mountInspectorShell: (ctor: typeof InspectorShell) => void;
      inspectorShell: InspectorShell | null;
    };
    mgrAny.installRevealPanelListener();
    mgrAny.mountInspectorShell(InspectorShell);

    expect(mgrAny.inspectorShell!.getActiveTab()).toBe('overview');

    // Denied actions must NOT switch the active inspector tab
    const deniedMissing = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'markets' });
    expect(deniedMissing.ok).toBe(false);
    expect(deniedMissing.reason).toBe('panel_not_live');
    expect(mgrAny.inspectorShell!.getActiveTab()).toBe('overview');

    const deniedDisabled = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'crypto' });
    expect(deniedDisabled.ok).toBe(false);
    expect(deniedDisabled.reason).toBe('panel_disabled');
    expect(mgrAny.inspectorShell!.getActiveTab()).toBe('overview');

    const deniedEntitled = applyAgentBusAction(
      ctx,
      { type: 'open_panel', panelId: 'supply-chain' },
      { isPanelAllowed: () => false },
    );
    expect(deniedEntitled.ok).toBe(false);
    expect(deniedEntitled.reason).toBe('panel_not_entitled');
    expect(mgrAny.inspectorShell!.getActiveTab()).toBe('overview');

    // Entitled live panel switches tab through real PanelLayoutManager listener and succeeds
    const ok = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'gdelt-intel' });
    expect(ok.ok).toBe(true);
    expect(mgrAny.inspectorShell!.getActiveTab()).toBe('security');
    expect(gdelt.getElement().classList.contains('inspector-tab-hidden')).toBe(false);

    // If still hidden by mobile filter, agent denies honestly
    gdelt.getElement().classList.add('mobile-cat-hidden');
    const deniedHidden = applyAgentBusAction(ctx, { type: 'open_panel', panelId: 'gdelt-intel' });
    expect(deniedHidden.ok).toBe(false);
    expect(deniedHidden.reason).toBe('panel_hidden');

    manager.destroy();
  });

  it('mounts all 7 Overview panels at boot, handles non-Overview saved tabs without flashing all panels (B-I3, B-M4), and blocks all bottom-zone write paths (B-I4)', () => {
    document.body.innerHTML = `
      <div id="mapSection"></div>
      <div id="mapBottomGrid" class="map-bottom-grid"><div class="panel" data-panel="markets"></div></div>
      <div id="panelsGrid" class="panels-grid"></div>
    `;
    const grid = document.getElementById('panelsGrid')!;
    const bottomGrid = document.getElementById('mapBottomGrid')!;

    const overviewKeys = [
      'insights', 'strategic-risk', 'cii', 'threat-timeline', 'markets', 'energy-complex', 'latest-brief',
    ];
    const settings: Record<string, PanelConfig> = {
      'live-news': { name: 'Live News', enabled: true, priority: 1 },
      'live-webcams': { name: 'Live Webcams', enabled: true, priority: 1 },
      'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 2 },
      ...Object.fromEntries(overviewKeys.map((k) => [k, { name: k, enabled: true, priority: 1 }])),
    };
    localStorage.setItem('panel-order', JSON.stringify(['live-news', 'live-webcams', ...overviewKeys]));

    const { manager } = makeLayoutManager(settings);
    const mgrAny = manager as unknown as {
      computeInitialVisiblePanelSet: () => Set<string> | null;
      initialVisiblePanelSet: Set<string> | null;
      shouldMountPanelImmediately: (key: string) => boolean;
      resolvedPanelOrder: string[];
      makeDraggable: (el: HTMLElement, key: string) => void;
      collectPanelLayoutEntries: () => { panels: unknown[]; bottomAvailable: boolean } | null;
    };

    // 1. Default Overview mounts all 7 curated panels immediately and defers non-Overview panels
    mgrAny.initialVisiblePanelSet = mgrAny.computeInitialVisiblePanelSet();
    expect(mgrAny.shouldMountPanelImmediately('live-news')).toBe(false);
    expect(mgrAny.shouldMountPanelImmediately('live-webcams')).toBe(false);
    expect(mgrAny.shouldMountPanelImmediately('gdelt-intel')).toBe(false);
    for (const key of overviewKeys) {
      expect(mgrAny.shouldMountPanelImmediately(key)).toBe(true);
    }

    // 2. Saved non-Overview tab holds panels hidden until shell mounts (no 86-panel flash, B-M4)
    localStorage.setItem('wm-inspector-tab-v1', 'security');
    expect(mgrAny.computeInitialVisiblePanelSet()?.size).toBe(0);
    localStorage.setItem('wm-inspector-tab-v1', 'all');
    expect(mgrAny.computeInitialVisiblePanelSet()).toBeNull();
    localStorage.setItem('wm-inspector-tab-v1', 'bogus-tab');
    expect(mgrAny.computeInitialVisiblePanelSet()?.has('insights')).toBe(true);

    // 3. ensureCorrectZones migrates any stray panel out of #mapBottomGrid back into #panelsGrid
    mgrAny.resolvedPanelOrder = overviewKeys;
    manager.ensureCorrectZones();
    expect(bottomGrid.querySelectorAll('.panel').length).toBe(0);
    const marketsEl = grid.querySelector<HTMLElement>('[data-panel="markets"]')!;
    expect(marketsEl).toBeTruthy();

    // 4. B-I4: agent layout tool reports bottomAvailable=false and denies moving to bottom
    const layout = mgrAny.collectPanelLayoutEntries();
    expect(layout?.bottomAvailable).toBe(false);
    const moveBottom = manager.applyWebMcpMovePanel('markets', 'bottom', 0);
    expect(moveBottom.ok).toBe(false);
    expect(moveBottom.reason).toBe('region_unavailable');
    expect(bottomGrid.querySelectorAll('.panel').length).toBe(0);

    // 5. B-I4: keyboard PageDown does not move panel into #mapBottomGrid
    const header = document.createElement('div');
    header.className = 'panel-header';
    marketsEl.appendChild(header);
    mgrAny.makeDraggable(marketsEl, 'markets');
    const moveBtn = marketsEl.querySelector<HTMLButtonElement>('.panel-move-btn')!;
    expect(moveBtn.getAttribute('aria-keyshortcuts')).not.toContain('PageDown');
    moveBtn.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true }));
    expect(marketsEl.parentElement).toBe(grid);
    expect(bottomGrid.querySelectorAll('.panel').length).toBe(0);

    manager.destroy();
  });

  it('re-hides a disabled panel when released from BottomMediaTray (B-M5)', async () => {
    document.body.innerHTML = `
      <div id="panelsGrid" class="panels-grid"></div>
      <div id="bottomTrayMount"></div>
    `;
    const grid = document.getElementById('panelsGrid')!;
    const disabledNews = makeFakePanel('live-news');
    disabledNews.toggle(false);
    grid.appendChild(disabledNews.getElement());

    const settings: Record<string, PanelConfig> = {
      'live-news': { name: 'Live News', enabled: false, priority: 2 },
    };
    const { manager } = makeLayoutManager(settings, { 'live-news': disabledNews });
    const mgrAny = manager as unknown as {
      mountBottomMediaTray: (ctor: typeof BottomMediaTray) => void;
      bottomMediaTray: BottomMediaTray | null;
    };
    mgrAny.mountBottomMediaTray(BottomMediaTray);

    await mgrAny.bottomMediaTray!.open('live-news', 'Live News');
    expect(disabledNews.getElement().classList.contains('hidden')).toBe(false);

    mgrAny.bottomMediaTray!.close();
    expect(grid.contains(disabledNews.getElement())).toBe(true);
    expect(disabledNews.getElement().classList.contains('hidden')).toBe(true);

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

    btn.click();
    expect(popover.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');

    document.getElementById('outsideTarget')!.click();
    expect(popover.hidden).toBe(true);

    btn.click();
    expect(popover.hidden).toBe(false);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(popover.hidden).toBe(true);

    btn.click();
    expect(popover.hidden).toBe(false);
    manager.destroy();
    document.getElementById('outsideTarget')!.click();
    expect(popover.hidden).toBe(false);
  });

  it('bindLayerSearch expands matching groups and sanitizeLayersForVariant strips non-variant preset layers', () => {
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

    // Real variant sanitization: applying Hazards on tech keeps outages & natural while Energy's pipelines is stripped
    const hazardsPreset = MAP_LAYER_PRESETS.find((p) => p.id === 'hazards')!;
    const energyPreset = MAP_LAYER_PRESETS.find((p) => p.id === 'energy')!;
    const rawLayers: MapLayers = { ...DEFAULT_MAP_LAYERS };
    for (const k of Object.keys(rawLayers) as Array<keyof MapLayers>) rawLayers[k] = false;
    for (const k of [...hazardsPreset.layers, ...energyPreset.layers]) rawLayers[k] = true;

    const sanitizedTech = sanitizeLayersForVariant(rawLayers, 'tech');
    expect(sanitizedTech.outages).toBe(true);
    expect(sanitizedTech.natural).toBe(true);
    expect(sanitizedTech.pipelines).toBe(false);
  });
});
