import type { PanelConfig } from '@/types';
import {
  ALL_PANELS,
  SITE_VARIANT,
} from '@/config';
import {
  INSPECTOR_TABS,
  MARKETS_SUB_FILTERS,
  NEWS_SUB_FILTERS,
  getInspectorTabForPanel,
  getOverviewPanelKeys,
  isPanelVisibleInInspectorTab,
  type InspectorTabId,
  type MarketsSubFilter,
  type NewsSubFilter,
} from '@/config/inspector-domains';
import { getPanelDisplayName } from '@/services/panel-display-name';
import { safeStorageGet, safeStorageSet } from '@/utils/safe-storage';

const TAB_STORAGE_KEY = 'wm-inspector-tab-v1';
const OVERVIEW_PINS_KEY = 'wm-inspector-overview-pins-v1';

const VALID_TABS = new Set<InspectorTabId>(['overview', 'security', 'markets', 'news', 'all']);

export interface InspectorShellCallbacks {
  getPanelSettings: () => Record<string, PanelConfig>;
  onTogglePanelEnabled: (panelId: string, enabled: boolean) => void;
  onRevealPanel: (panelId: string) => void;
  onTabChanged: (tab: InspectorTabId, visiblePanelIds: string[]) => void;
  onOpenSettings: () => void;
  onToggleCollapse: () => void;
}

function isKoreanUi(): boolean {
  return typeof document !== 'undefined' && document.documentElement.lang?.startsWith('ko');
}

function loadSavedTab(): InspectorTabId {
  const raw = safeStorageGet(TAB_STORAGE_KEY);
  if (raw && VALID_TABS.has(raw as InspectorTabId)) return raw as InspectorTabId;
  return 'overview';
}

function loadOverviewPins(): string[] | null {
  const raw = safeStorageGet(OVERVIEW_PINS_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const valid = parsed.filter((item): item is string => typeof item === 'string' && item.length > 0 && item !== 'map');
    return valid.length > 0 ? valid : null;
  } catch {
    return null;
  }
}

function saveOverviewPins(pins: string[] | null): void {
  if (!pins || pins.length === 0) {
    safeStorageSet(OVERVIEW_PINS_KEY, '');
    return;
  }
  safeStorageSet(OVERVIEW_PINS_KEY, JSON.stringify(pins));
}

/**
 * Option B right-hand 1-column tabbed inspector header & 168-panel catalog.
 *
 * Visibility is applied non-destructively via `.inspector-tab-hidden` on
 * `#panelsGrid > [data-panel]`, leaving user `localStorage` panel enabled flags,
 * order, spans, and custom tabs intact.
 */
export class InspectorShell {
  private readonly root: HTMLElement;
  private readonly tabBar: HTMLElement;
  private readonly subBar: HTMLElement;
  private readonly catalogDrawer: HTMLElement;
  private readonly catalogList: HTMLElement;
  private readonly catalogSearch: HTMLInputElement;
  private readonly tabsHostSlot: HTMLElement;
  private activeTab: InspectorTabId;
  private marketsSub: MarketsSubFilter = 'all';
  private newsSub: NewsSubFilter = 'all';
  private catalogQuery = '';
  private pinnedOverview: string[] | null;
  private readonly callbacks: InspectorShellCallbacks;
  private readonly boundRevealHandler: (e: Event) => void;

  constructor(callbacks: InspectorShellCallbacks) {
    this.callbacks = callbacks;
    this.activeTab = loadSavedTab();
    this.pinnedOverview = loadOverviewPins();

    this.root = document.createElement('div');
    this.root.className = 'inspector-shell-header';

    const topRow = document.createElement('div');
    topRow.className = 'inspector-top-row';

    this.tabBar = document.createElement('div');
    this.tabBar.className = 'inspector-tabs';
    this.tabBar.setAttribute('role', 'tablist');
    this.tabBar.setAttribute('aria-label', isKoreanUi() ? '인스펙터 섹션' : 'Inspector sections');

    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className = 'inspector-collapse-btn';
    collapseBtn.id = 'inspectorCollapseBtn';
    collapseBtn.textContent = '⇥';
    collapseBtn.title = isKoreanUi() ? '인스펙터 접기/펼치기' : 'Collapse inspector';
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
    collapseBtn.addEventListener('click', () => this.callbacks.onToggleCollapse());

    topRow.append(this.tabBar, collapseBtn);

    this.subBar = document.createElement('div');
    this.subBar.className = 'inspector-subbar';
    this.subBar.hidden = true;

    this.catalogDrawer = document.createElement('div');
    this.catalogDrawer.className = 'inspector-catalog';
    this.catalogDrawer.hidden = true;

    this.tabsHostSlot = document.createElement('div');
    this.tabsHostSlot.className = 'inspector-custom-tabs-slot';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'inspector-catalog-search-wrap';

    this.catalogSearch = document.createElement('input');
    this.catalogSearch.type = 'search';
    this.catalogSearch.className = 'inspector-catalog-search';
    this.catalogSearch.autocomplete = 'off';
    this.catalogSearch.spellcheck = false;
    const panelTotal = Object.keys(ALL_PANELS).filter((k) => k !== 'map').length;
    this.catalogSearch.placeholder = isKoreanUi()
      ? `전체 ${panelTotal}개 패널 검색 (이름 · 영문 키)...`
      : `Search all ${panelTotal} panels...`;
    this.catalogSearch.setAttribute('aria-label', this.catalogSearch.placeholder);
    this.catalogSearch.addEventListener('input', () => {
      this.catalogQuery = this.catalogSearch.value.trim().toLowerCase();
      this.renderCatalogList();
    });

    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className = 'inspector-catalog-settings-btn';
    settingsBtn.textContent = isKoreanUi() ? '패널 설정' : 'Settings';
    settingsBtn.addEventListener('click', () => this.callbacks.onOpenSettings());

    searchWrap.append(this.catalogSearch, settingsBtn);

    this.catalogList = document.createElement('div');
    this.catalogList.className = 'inspector-catalog-list';

    this.catalogDrawer.append(this.tabsHostSlot, searchWrap, this.catalogList);
    this.root.append(topRow, this.subBar, this.catalogDrawer);

    this.boundRevealHandler = (e: Event) => {
      const panelId = (e as CustomEvent<{ panelId?: string }>).detail?.panelId;
      if (!panelId || panelId === 'map') return;
      this.revealPanelInTab(panelId);
    };
    window.addEventListener('wm:reveal-panel', this.boundRevealHandler);

    this.renderTabs();
    this.renderSubBar();
  }

  public getElement(): HTMLElement {
    return this.root;
  }

  public getCustomTabsSlot(): HTMLElement {
    return this.tabsHostSlot;
  }

  public getActiveTab(): InspectorTabId {
    return this.activeTab;
  }

  public selectTab(tab: InspectorTabId, notify = true): void {
    if (!VALID_TABS.has(tab)) return;
    this.activeTab = tab;
    safeStorageSet(TAB_STORAGE_KEY, tab);
    this.renderTabs();
    this.renderSubBar();
    this.catalogDrawer.hidden = tab !== 'all';
    if (tab === 'all') {
      this.renderCatalogList();
    }
    const visible = this.applyGridFilter();
    if (notify) {
      this.callbacks.onTabChanged(tab, visible);
    }
  }

  public refresh(): void {
    this.renderTabs();
    this.renderSubBar();
    this.catalogDrawer.hidden = this.activeTab !== 'all';
    if (this.activeTab === 'all') {
      this.renderCatalogList();
    }
    this.applyGridFilter();
  }

  public applyToElement(el: HTMLElement): void {
    const key = el.dataset.panel;
    if (!key) return;
    const visible = this.isPanelVisibleNow(key);
    el.classList.toggle('inspector-tab-hidden', !visible);
  }

  public applyGridFilter(): string[] {
    const grid = document.getElementById('panelsGrid');
    if (!grid) return [];
    const visibleKeys: string[] = [];
    grid.querySelectorAll<HTMLElement>(':scope > [data-panel]').forEach((el) => {
      const key = el.dataset.panel;
      if (!key) return;
      const visible = this.isPanelVisibleNow(key);
      el.classList.toggle('inspector-tab-hidden', !visible);
      if (visible && !el.classList.contains('hidden')) {
        visibleKeys.push(key);
      }
    });
    return visibleKeys;
  }

  public revealPanelInTab(panelId: string): void {
    if (this.isPanelVisibleNow(panelId)) return;
    const ownerTab = getInspectorTabForPanel(panelId, SITE_VARIANT);
    this.marketsSub = 'all';
    this.newsSub = 'all';
    this.selectTab(ownerTab, true);
    if (!this.isPanelVisibleNow(panelId)) {
      this.selectTab('all', true);
    }
  }

  public isPanelVisible(panelId: string): boolean {
    return this.isPanelVisibleNow(panelId);
  }

  public destroy(): void {
    window.removeEventListener('wm:reveal-panel', this.boundRevealHandler);
    this.root.remove();
  }

  private isPanelVisibleNow(panelId: string): boolean {
    return isPanelVisibleInInspectorTab(panelId, this.activeTab, {
      variant: SITE_VARIANT,
      panelSettings: this.callbacks.getPanelSettings(),
      pinnedOverview: this.pinnedOverview,
      marketsSubFilter: this.marketsSub,
      newsSubFilter: this.newsSub,
    });
  }

  private renderTabs(): void {
    const ko = isKoreanUi();
    this.tabBar.replaceChildren(
      ...INSPECTOR_TABS.map((tab) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `inspector-tab-btn${this.activeTab === tab.id ? ' active' : ''}`;
        btn.dataset.inspectorTab = tab.id;
        btn.setAttribute('role', 'tab');
        btn.setAttribute('aria-selected', String(this.activeTab === tab.id));
        const icon = document.createElement('span');
        icon.className = 'inspector-tab-icon';
        icon.setAttribute('aria-hidden', 'true');
        icon.textContent = tab.icon;
        const label = document.createElement('span');
        label.className = 'inspector-tab-label';
        label.textContent = ko ? tab.labelKo : tab.labelEn;
        btn.append(icon, label);
        btn.addEventListener('click', () => this.selectTab(tab.id, true));
        return btn;
      }),
    );
  }

  private renderSubBar(): void {
    const ko = isKoreanUi();
    if (this.activeTab === 'markets') {
      this.subBar.hidden = false;
      this.subBar.replaceChildren(
        ...MARKETS_SUB_FILTERS.map((f) => this.makeSubChip(ko ? f.labelKo : f.labelEn, this.marketsSub === f.id, () => {
          this.marketsSub = f.id;
          this.renderSubBar();
          const visible = this.applyGridFilter();
          this.callbacks.onTabChanged(this.activeTab, visible);
        })),
      );
      return;
    }
    if (this.activeTab === 'news') {
      this.subBar.hidden = false;
      this.subBar.replaceChildren(
        ...NEWS_SUB_FILTERS.map((f) => this.makeSubChip(ko ? f.labelKo : f.labelEn, this.newsSub === f.id, () => {
          this.newsSub = f.id;
          this.renderSubBar();
          const visible = this.applyGridFilter();
          this.callbacks.onTabChanged(this.activeTab, visible);
        })),
      );
      return;
    }
    if (this.activeTab === 'overview') {
      const settings = this.callbacks.getPanelSettings();
      const overviewCount = getOverviewPanelKeys(SITE_VARIANT, settings, this.pinnedOverview).length;
      const enabledTotal = Object.entries(settings).filter(([k, cfg]) => k !== 'map' && cfg.enabled).length;
      this.subBar.hidden = false;
      const hint = document.createElement('span');
      hint.className = 'inspector-overview-hint';
      hint.textContent = ko
        ? `핵심 ${overviewCount}개 표시 중 · 전체 활성 ${enabledTotal}개`
        : `Showing ${overviewCount} core · ${enabledTotal} active`;
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'inspector-overview-edit-btn';
      editBtn.textContent = ko ? '패널 관리 ▸' : 'Manage ▸';
      editBtn.addEventListener('click', () => this.selectTab('all', true));
      this.subBar.replaceChildren(hint, editBtn);
      return;
    }
    this.subBar.hidden = true;
    this.subBar.replaceChildren();
  }

  private makeSubChip(label: string, active: boolean, onClick: () => void): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `inspector-sub-chip${active ? ' active' : ''}`;
    btn.setAttribute('aria-pressed', String(active));
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  private toggleOverviewPin(panelId: string): void {
    const settings = this.callbacks.getPanelSettings();
    const current = new Set(getOverviewPanelKeys(SITE_VARIANT, settings, this.pinnedOverview));
    if (current.has(panelId)) {
      current.delete(panelId);
    } else {
      if (settings[panelId] && !settings[panelId].enabled) {
        this.callbacks.onTogglePanelEnabled(panelId, true);
      }
      current.add(panelId);
    }
    const next = current.size > 0 ? [...current] : null;
    this.pinnedOverview = next;
    saveOverviewPins(next);
    this.renderCatalogList();
  }

  private renderCatalogList(): void {
    const ko = isKoreanUi();
    const settings = this.callbacks.getPanelSettings();
    const pinnedSet = new Set(getOverviewPanelKeys(SITE_VARIANT, settings, this.pinnedOverview));
    const q = this.catalogQuery;

    const allKeys = Array.from(new Set([...Object.keys(settings), ...Object.keys(ALL_PANELS)]))
      .filter((k) => k !== 'map');

    const matches = allKeys
      .map((key) => {
        const displayName = getPanelDisplayName(key);
        const fallback = ALL_PANELS[key]?.name ?? settings[key]?.name ?? key;
        const enabled = settings[key]?.enabled === true;
        return { key, displayName, fallback, enabled };
      })
      .filter(({ key, displayName, fallback }) => {
        if (!q) return true;
        return displayName.toLowerCase().includes(q)
          || fallback.toLowerCase().includes(q)
          || key.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
        return a.displayName.localeCompare(b.displayName);
      });

    const nodes: HTMLElement[] = [];

    const summary = document.createElement('div');
    summary.className = 'inspector-catalog-meta';
    summary.textContent = q
      ? (ko ? `검색 결과 ${matches.length}개` : `${matches.length} matching panels`)
      : (ko
          ? `전체 ${allKeys.length}개 패널 (검색어로 즉시 찾기 · ★ 클릭 시 요약 탭 고정)`
          : `${allKeys.length} total panels (search to filter · ★ pins to Overview)`);
    nodes.push(summary);

    for (const item of matches) {
      const row = document.createElement('div');
      row.className = `inspector-catalog-row${item.enabled ? ' enabled' : ''}`;

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = item.enabled;
      toggle.setAttribute('aria-label', item.displayName);
      toggle.addEventListener('change', () => {
        this.callbacks.onTogglePanelEnabled(item.key, toggle.checked);
        this.renderCatalogList();
      });

      const nameBtn = document.createElement('button');
      nameBtn.type = 'button';
      nameBtn.className = 'inspector-catalog-name';
      nameBtn.textContent = item.displayName;
      nameBtn.title = item.key;
      nameBtn.addEventListener('click', () => {
        if (!item.enabled) {
          this.callbacks.onTogglePanelEnabled(item.key, true);
        }
        this.callbacks.onRevealPanel(item.key);
      });

      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      const isPinned = pinnedSet.has(item.key);
      pinBtn.className = `inspector-catalog-pin${isPinned ? ' pinned' : ''}`;
      pinBtn.textContent = isPinned ? '★' : '☆';
      pinBtn.title = ko ? '요약 탭에 고정/해제' : 'Pin to Overview';
      pinBtn.setAttribute('aria-pressed', String(isPinned));
      pinBtn.addEventListener('click', () => this.toggleOverviewPin(item.key));

      row.append(toggle, nameBtn, pinBtn);
      nodes.push(row);
    }

    this.catalogList.replaceChildren(...nodes);
  }
}
