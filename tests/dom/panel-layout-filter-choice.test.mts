/**
 * A tab's panel filter choices (#10453, phase 2) as the layout applies them.
 * The layout needs the whole app to construct, so the methods are called on a
 * minimal stand-in `this`, the way correlation-recovery does for mounting.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { PanelLayoutManager } from '@/app/panel-layout';
import type { Panel } from '@/components/Panel';
import { initTestI18n } from './helpers/i18n.mts';

beforeAll(initTestI18n);

type Fake = {
  appliedPanelFilters: Set<string>;
  ctx: { panels: Record<string, unknown> };
  activeTab: () => { panelFilters?: Record<string, string> } | undefined;
  tabsState: { activeTabId: string; tabs: Array<{ id: string; panelFilters?: Record<string, string> }> } | null;
  onPanelFilterChanged: ReturnType<typeof vi.fn>;
};

const method = <T extends (...args: never[]) => unknown>(name: string): T =>
  Reflect.get(PanelLayoutManager.prototype, name) as T;

function panel(): Panel & { choice: string | null } {
  const p = {
    choice: null as string | null,
    hasFilterChoice: () => true,
    setFilterChoice(value: string | null) {
      p.choice = value;
    },
    onFilterChoiceChange: vi.fn(),
  };
  return p as unknown as Panel & { choice: string | null };
}

describe('PanelLayoutManager panel filter choices', () => {
  it('records a choice restored when a lazy panel mounts, so the next tab switch resets it', () => {
    const filterPanel = panel();
    const self: Fake = {
      appliedPanelFilters: new Set(),
      ctx: { panels: { 'second-panel': filterPanel } },
      activeTab: () => ({ panelFilters: { 'second-panel': 'europe' } }),
      tabsState: null,
      onPanelFilterChanged: vi.fn(),
    };
    method<(key: string, p: Panel) => void>('bindPanelFilterChoice').call(self, 'second-panel', filterPanel);
    expect(filterPanel.choice).toBe('europe');
    expect(self.appliedPanelFilters.has('second-panel')).toBe(true);

    // Switching to a tab with no choice for the panel puts it back to its default.
    method<(filters: Record<string, string> | undefined) => void>('applyTabPanelFilters').call(self, undefined);
    expect(filterPanel.choice).toBeNull();
    expect(self.appliedPanelFilters.size).toBe(0);
  });

  it('records the active tab choices at startup, before any panel mounts', () => {
    const filterPanel = panel();
    const self: Fake = {
      appliedPanelFilters: new Set(),
      ctx: { panels: {} },
      activeTab: () => ({ panelFilters: { 'second-panel': 'asia', forecast: '' } }),
      tabsState: null,
      onPanelFilterChanged: vi.fn(),
    };
    method<() => void>('seedAppliedPanelFilters').call(self);
    expect([...self.appliedPanelFilters].sort()).toEqual(['forecast', 'second-panel']);

    // The panel mounts later and the user then moves to a tab without a choice.
    self.ctx.panels['second-panel'] = filterPanel;
    filterPanel.choice = 'asia';
    method<(filters: Record<string, string> | undefined) => void>('applyTabPanelFilters').call(self, undefined);
    expect(filterPanel.choice).toBeNull();
  });

  it('applies the active tab choices to panels that mounted before the tabs loaded (reload)', () => {
    const forecast = panel();
    const self = {
      appliedPanelFilters: new Set<string>(),
      ctx: { panels: { forecast } },
      activeTab: () => ({ panelFilters: { forecast: 'asia' } }),
      unsubscribeScope: null as (() => void) | null,
      focusBar: null,
      onScopeChanged: vi.fn(),
      seedAppliedPanelFilters: undefined as unknown as () => void,
      applyTabPanelFilters: undefined as unknown as (filters: Record<string, string> | undefined) => void,
    };
    self.seedAppliedPanelFilters = method<() => void>('seedAppliedPanelFilters').bind(self);
    self.applyTabPanelFilters = method<(filters: Record<string, string> | undefined) => void>('applyTabPanelFilters').bind(self);
    method<() => void>('initFocus').call(self);
    expect(forecast.choice).toBe('asia');
    self.unsubscribeScope?.();
  });

  it('keeps an explicit All choice as a value, not an absent key', () => {
    const filterPanel = panel();
    const self: Fake = {
      appliedPanelFilters: new Set(),
      ctx: { panels: { 'second-panel': filterPanel } },
      activeTab: () => ({ panelFilters: { 'second-panel': 'all' } }),
      tabsState: null,
      onPanelFilterChanged: vi.fn(),
    };
    method<(key: string, p: Panel) => void>('bindPanelFilterChoice').call(self, 'second-panel', filterPanel);
    expect(filterPanel.choice).toBe('all');
  });
});
