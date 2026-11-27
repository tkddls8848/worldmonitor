import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InspectorShell } from '@/components/InspectorShell';
import { BottomMediaTray } from '@/components/BottomMediaTray';
import { Panel } from '@/components/Panel';
import { SignalModal } from '@/components/SignalModal';
import { UnifiedSettings } from '@/components/UnifiedSettings';
import { applyFont, getFontFamily, setFontFamily } from '@/services/font-settings';
import type { PanelConfig } from '@/types';

function makePanelSettings(): Record<string, PanelConfig> {
  return {
    insights: { name: 'AI Insights', enabled: true, priority: 1 },
    'strategic-risk': { name: 'Strategic Risk', enabled: true, priority: 1 },
    cii: { name: 'Country Instability', enabled: true, priority: 1 },
    'threat-timeline': { name: 'Threat Timeline', enabled: true, priority: 1 },
    markets: { name: 'Markets', enabled: true, priority: 1 },
    'energy-complex': { name: 'Energy Complex', enabled: true, priority: 1 },
    'latest-brief': { name: 'Latest Brief', enabled: true, priority: 1 },
    'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 2 },
    politics: { name: 'World News', enabled: true, priority: 2 },
    crypto: { name: 'Crypto', enabled: false, priority: 3 },
  };
}

function createSettings(): UnifiedSettings {
  return new UnifiedSettings({
    getPanelSettings: () => ({}),
    savePanelSettings: () => {},
    getDisabledSources: () => new Set<string>(),
    toggleSource: () => {},
    setSourcesEnabled: () => {},
    getAllSourceNames: () => [],
    getLocalizedPanelName: (_key: string, fallback: string) => fallback,
    resetLayout: () => {},
  });
}

describe('InspectorShell', () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="panelsGrid"></div>';
    document.documentElement.lang = 'ko';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('restores saved tab and falls back to overview on invalid or blocked storage', () => {
    localStorage.setItem('wm-inspector-tab-v1', 'security');
    const shell = new InspectorShell({
      getPanelSettings: makePanelSettings,
      onTogglePanelEnabled: vi.fn(),
      onRevealPanel: vi.fn(),
      onTabChanged: vi.fn(),
      onOpenSettings: vi.fn(),
      onToggleCollapse: vi.fn(),
    });
    expect(shell.getActiveTab()).toBe('security');
    shell.destroy();

    localStorage.setItem('wm-inspector-tab-v1', 'not-a-real-tab');
    const fallback = new InspectorShell({
      getPanelSettings: makePanelSettings,
      onTogglePanelEnabled: vi.fn(),
      onRevealPanel: vi.fn(),
      onTabChanged: vi.fn(),
      onOpenSettings: vi.fn(),
      onToggleCollapse: vi.fn(),
    });
    expect(fallback.getActiveTab()).toBe('overview');
    fallback.destroy();

    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked storage');
    });
    try {
      const blocked = new InspectorShell({
        getPanelSettings: makePanelSettings,
        onTogglePanelEnabled: vi.fn(),
        onRevealPanel: vi.fn(),
        onTabChanged: vi.fn(),
        onOpenSettings: vi.fn(),
        onToggleCollapse: vi.fn(),
      });
      expect(blocked.getActiveTab()).toBe('overview');
      blocked.destroy();
    } finally {
      getItemSpy.mockRestore();
    }
  });

  it('filters panels via .inspector-tab-hidden and switches tabs on wm:reveal-panel', () => {
    const grid = document.getElementById('panelsGrid')!;
    for (const id of ['insights', 'gdelt-intel', 'politics', 'markets']) {
      const el = document.createElement('div');
      el.className = 'panel';
      el.dataset.panel = id;
      grid.appendChild(el);
    }

    const onTabChanged = vi.fn();
    const shell = new InspectorShell({
      getPanelSettings: makePanelSettings,
      onTogglePanelEnabled: vi.fn(),
      onRevealPanel: vi.fn(),
      onTabChanged,
      onOpenSettings: vi.fn(),
      onToggleCollapse: vi.fn(),
    });
    document.body.prepend(shell.getElement());

    const visibleOverview = shell.applyGridFilter();
    expect(visibleOverview).toEqual(['insights', 'markets']);
    expect(grid.querySelector('[data-panel="gdelt-intel"]')?.classList.contains('inspector-tab-hidden')).toBe(true);
    expect(grid.querySelector('[data-panel="politics"]')?.classList.contains('inspector-tab-hidden')).toBe(true);

    // Reveal gdelt-intel from another tab
    window.dispatchEvent(new CustomEvent('wm:reveal-panel', { detail: { panelId: 'gdelt-intel' } }));
    expect(shell.getActiveTab()).toBe('security');
    expect(grid.querySelector('[data-panel="gdelt-intel"]')?.classList.contains('inspector-tab-hidden')).toBe(false);
    expect(onTabChanged).toHaveBeenCalledWith('security', expect.arrayContaining(['gdelt-intel']));

    shell.destroy();
  });

  it('catalog checkbox and pin star invoke callbacks and persist overview pins', () => {
    const settings = makePanelSettings();
    const onTogglePanelEnabled = vi.fn((panelId: string, enabled: boolean) => {
      settings[panelId] = { name: panelId, enabled, priority: 2 };
    });
    const onRevealPanel = vi.fn();

    const shell = new InspectorShell({
      getPanelSettings: () => settings,
      onTogglePanelEnabled,
      onRevealPanel,
      onTabChanged: vi.fn(),
      onOpenSettings: vi.fn(),
      onToggleCollapse: vi.fn(),
    });
    document.body.appendChild(shell.getElement());

    shell.selectTab('all', false);
    const search = shell.getElement().querySelector<HTMLInputElement>('.inspector-catalog-search')!;
    search.value = 'gdelt-intel';
    search.dispatchEvent(new Event('input'));

    const row = shell.getElement().querySelector('.inspector-catalog-row')!;
    expect(row).toBeTruthy();

    const checkbox = row.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    checkbox.checked = false;
    checkbox.dispatchEvent(new Event('change'));
    expect(onTogglePanelEnabled).toHaveBeenCalledWith('gdelt-intel', false);

    // Re-query after list rerender and pin to overview (should also re-enable)
    const pinBtn = shell.getElement().querySelector<HTMLButtonElement>('.inspector-catalog-pin')!;
    pinBtn.click();
    expect(onTogglePanelEnabled).toHaveBeenCalledWith('gdelt-intel', true);
    const storedPins = JSON.parse(localStorage.getItem('wm-inspector-overview-pins-v1') || '[]') as string[];
    expect(storedPins).toContain('gdelt-intel');

    shell.destroy();
  });
});

describe('BottomMediaTray', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens, hosts, closes on Escape, releases back to grid, and cleans up listeners on destroy', async () => {
    const grid = document.createElement('div');
    grid.id = 'panelsGrid';
    const liveNewsEl = document.createElement('div');
    liveNewsEl.className = 'panel inspector-tab-hidden';
    liveNewsEl.dataset.panel = 'live-news';
    grid.appendChild(liveNewsEl);
    document.body.appendChild(grid);

    const onReleasePanelElement = vi.fn((_id: string, el: HTMLElement) => {
      grid.appendChild(el);
    });
    const tray = new BottomMediaTray({
      onRequestPanelElement: vi.fn(async (id) => (id === 'live-news' ? liveNewsEl : null)),
      onReleasePanelElement,
      onToggleWideGrid: vi.fn(() => true),
      onOpenTabsManager: vi.fn(),
    });
    document.body.appendChild(tray.getElement());

    await tray.open('live-news', 'Live News');
    expect(tray.getActivePanelId()).toBe('live-news');
    expect(liveNewsEl.classList.contains('tray-hosted-panel')).toBe(true);
    expect(liveNewsEl.classList.contains('inspector-tab-hidden')).toBe(false);
    expect(tray.getElement().querySelector('.bottom-tray-drawer-body')?.contains(liveNewsEl)).toBe(true);

    // Escape closes and returns element to grid
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(tray.getActivePanelId()).toBeNull();
    expect(onReleasePanelElement).toHaveBeenCalledWith('live-news', liveNewsEl);
    expect(grid.contains(liveNewsEl)).toBe(true);

    // Missing panel closes drawer cleanly instead of leaving an empty shell
    await tray.open('chat-analyst', 'AI Analyst');
    expect(tray.getActivePanelId()).toBeNull();
    expect(tray.getElement().querySelector<HTMLElement>('.bottom-tray-drawer')?.hidden).toBe(true);

    // destroy removes listeners
    tray.destroy();
    window.dispatchEvent(new CustomEvent('wm:open-tray-panel', { detail: { panelId: 'live-news' } }));
    expect(tray.getActivePanelId()).toBeNull();
  });
});

describe('Panel fullscreen modal and font-settings default', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    document.body.classList.remove('panel-modal-open');
    localStorage.clear();
    delete document.documentElement.dataset.font;
  });

  it('Escape still closes the expanded panel while closed persistent overlays (Settings, SignalModal) stay in the DOM', () => {
    const settings = createSettings();
    settings.open();
    settings.close();
    new SignalModal();
    const settingsEl = document.getElementById('unifiedSettingsModal');
    const signalEl = document.querySelector('.signal-modal-overlay');
    // Both are role=dialog overlays that remain mounted after closing.
    expect(settingsEl?.getAttribute('role')).toBe('dialog');
    expect(settingsEl?.classList.contains('active')).toBe(false);
    expect(signalEl?.getAttribute('role')).toBe('dialog');
    expect(signalEl?.classList.contains('active')).toBe(false);

    const panel = new Panel({ id: 'markets', title: 'Markets' });
    document.body.appendChild(panel.getElement());
    panel.getElement().querySelector<HTMLButtonElement>('.panel-expand-modal-btn')!.click();
    expect(panel.getElement().classList.contains('panel-modal-expanded')).toBe(true);

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.getElement().classList.contains('panel-modal-expanded')).toBe(false);
    panel.destroy();
  });

  it('expands via ⛶, yields Escape to higher modals and in-panel inputs, restores on Escape when topmost, and cleans up on destroy', () => {
    const panel = new Panel({ id: 'markets', title: 'Markets' });
    document.body.appendChild(panel.getElement());

    const expandBtn = panel.getElement().querySelector<HTMLButtonElement>('.panel-expand-modal-btn')!;
    expect(expandBtn).toBeTruthy();

    const underlyingEsc = vi.fn();
    document.addEventListener('keydown', underlyingEsc);
    try {
      expandBtn.click();
      expect(panel.getElement().classList.contains('panel-modal-expanded')).toBe(true);
      expect(document.body.classList.contains('panel-modal-open')).toBe(true);

      // Open Settings (the real overlay) receives Escape first without collapsing the expanded panel
      const settings = createSettings();
      settings.open();
      expect(document.getElementById('unifiedSettingsModal')?.classList.contains('active')).toBe(true);
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(panel.getElement().classList.contains('panel-modal-expanded')).toBe(true);
      expect(underlyingEsc).toHaveBeenCalledTimes(1);
      settings.close();
      expect(document.getElementById('unifiedSettingsModal')?.classList.contains('active')).toBe(false);

      // Editable input inside the expanded panel handles its own Escape without collapsing the panel
      const input = document.createElement('input');
      panel.getElement().appendChild(input);
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(panel.getElement().classList.contains('panel-modal-expanded')).toBe(true);
      input.remove();

      // When topmost, Escape restores modal and blocks underlying document listeners
      underlyingEsc.mockClear();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      expect(panel.getElement().classList.contains('panel-modal-expanded')).toBe(false);
      expect(document.body.classList.contains('panel-modal-open')).toBe(false);
      expect(underlyingEsc).not.toHaveBeenCalled();

      // Close button restores modal without firing wm:panel-close
      const closeEvents = vi.fn();
      panel.getElement().addEventListener('wm:panel-close', closeEvents);
      expandBtn.click();
      panel.getElement().querySelector<HTMLButtonElement>('.panel-close-btn')!.click();
      expect(panel.getElement().classList.contains('panel-modal-expanded')).toBe(false);
      expect(closeEvents).not.toHaveBeenCalled();

      // destroy clears body.panel-modal-open
      expandBtn.click();
      expect(document.body.classList.contains('panel-modal-open')).toBe(true);
      panel.destroy();
      expect(document.body.classList.contains('panel-modal-open')).toBe(false);
    } finally {
      document.removeEventListener('keydown', underlyingEsc);
    }
  });

  it('defaults font-settings to system without mutating html data-font, and honors mono preference', () => {
    expect(getFontFamily()).toBe('system');
    applyFont();
    expect(document.documentElement.dataset.font).toBeUndefined();

    setFontFamily('mono');
    expect(getFontFamily()).toBe('mono');
    expect(document.documentElement.dataset.font).toBe('mono');

    setFontFamily('system');
    expect(getFontFamily()).toBe('system');
    expect(document.documentElement.dataset.font).toBeUndefined();
  });
});
