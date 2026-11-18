import { DASHBOARD_TAB_NAME_MAX_LENGTH, type PanelTab, type TabsState } from '@/services/tab-store';
import { t } from '@/services/i18n';

export interface PanelTabBarCallbacks {
  onSelect(tabId: string): void;
  onAdd(): void;
  onRename(tabId: string, name: string): void;
  onDelete(tabId: string): void;
  /** Asked on every render and each time the options open. The bar never reads storage itself. */
  hasNewTabPanels(): boolean;
  onSaveNewTabPanels(): void;
  onClearNewTabPanels(): void;
  /** Dashboard focus (#10453). The "Focus" button shows when this is set. */
  focus?: FocusButtonCallbacks;
}

export interface FocusButtonCallbacks {
  /** Asked on every render: whether the active tab has a focus. */
  isFocused(): boolean;
  /** Start or edit the active tab's focus. The manager decides whether the account may. */
  onClick(): void;
}

/** The bar holds one popover at a time; this says which button it belongs to. */
type NoticeKind = 'options';

/**
 * Horizontal tab strip for dashboard workspaces. Pure DOM construction
 * (no innerHTML) so user-supplied tab names need no sanitization.
 *
 * Interactions: click switches tabs, double-click renames inline,
 * the per-tab close button deletes (hidden when only one tab remains),
 * the trailing "+" creates a new tab, and the "▾" beside it chooses whether
 * new tabs start with the default panels or with panels the user saved.
 */
export class PanelTabBar {
  private element: HTMLElement;
  private tablistEl: HTMLElement;
  private getState: () => TabsState;
  private callbacks: PanelTabBarCallbacks;
  private notice: HTMLElement | null = null;
  private noticeKind: NoticeKind | null = null;
  // Built once, unlike "+", so an open popover keeps its anchor and a truthful
  // aria-expanded across re-renders.
  private readonly optionsBtn: HTMLButtonElement;
  private readonly focusBtn: HTMLButtonElement;
  private readonly liveRegion: HTMLElement;
  private readonly onNoticeOutsideClick: (event: MouseEvent) => void;
  private readonly onNoticeKeyDown: (event: KeyboardEvent) => void;

  constructor(getState: () => TabsState, callbacks: PanelTabBarCallbacks) {
    this.getState = getState;
    this.callbacks = callbacks;
    this.element = document.createElement('div');
    this.element.className = 'dashboard-tabs-bar';

    // Created up front and empty: an aria-live region only announces content
    // injected AFTER it is in the accessibility tree.
    this.liveRegion = document.createElement('span');
    this.liveRegion.className = 'wm-visually-hidden';
    this.liveRegion.setAttribute('role', 'status');
    this.liveRegion.setAttribute('aria-live', 'polite');

    this.onNoticeOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (this.notice?.contains(target) || this.noticeAnchor()?.contains(target)) return;
      this.closeNotice();
    };
    this.onNoticeKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') this.closeNotice(true);
    };

    this.optionsBtn = document.createElement('button');
    this.optionsBtn.type = 'button';
    this.optionsBtn.className = 'dashboard-tab-options';
    this.optionsBtn.textContent = '▾';
    this.optionsBtn.title = t('dashboardTabs.newTabOptions');
    this.optionsBtn.setAttribute('aria-label', t('dashboardTabs.newTabOptions'));
    this.optionsBtn.setAttribute('aria-expanded', 'false');
    this.optionsBtn.addEventListener('click', () => this.toggleNewTabOptions());

    this.focusBtn = document.createElement('button');
    this.focusBtn.type = 'button';
    this.focusBtn.className = 'dashboard-tab-focus';
    this.focusBtn.textContent = t('focus.tabButton');
    this.focusBtn.addEventListener('click', () => this.callbacks.focus?.onClick());

    // ARIA: a role="tablist" may only own role="tab"/"presentation" children.
    // The trailing "+" button is an action, not a tab, so the tablist is an
    // inner element holding ONLY the tabs and the add button sits beside it in
    // the bar (see render()). This clears the aria-required-children violation.
    this.tablistEl = document.createElement('div');
    this.tablistEl.className = 'dashboard-tablist';
    this.tablistEl.setAttribute('role', 'tablist');
    this.tablistEl.setAttribute('aria-label', t('dashboardTabs.ariaLabel'));
    this.tablistEl.addEventListener('keydown', (e) => this.handleKeyDown(e));

    // Delegate dblclick at the tablist (attached ONCE, survives re-renders).
    // A per-label listener breaks for inactive tabs: the first click switches
    // tabs → render() → replaceChildren() swaps out the label node, so the two
    // clicks land on different elements and the browser dispatches dblclick on
    // their common ancestor (this container) rather than the new label.
    // Resolving the tab from the DOM here makes rename work on any tab.
    this.tablistEl.addEventListener('dblclick', (e) => {
      const target = e.target as HTMLElement;
      if (target.closest('.dashboard-tab-close')) return; // don't rename on delete dblclick
      const tabEl = (target.closest('.dashboard-tab') ??
        document.elementFromPoint(e.clientX, e.clientY)?.closest('.dashboard-tab')) as HTMLElement | null;
      if (!tabEl) return;
      const tabId = tabEl.dataset.tabId;
      if (!tabId) return;
      const tab = this.getState().tabs.find((tb) => tb.id === tabId);
      if (tab) this.startRename(tabEl, tab);
    });

    this.render();
  }

  getElement(): HTMLElement {
    return this.element;
  }

  refresh(): void {
    this.render();
  }

  destroy(): void {
    this.closeNotice();
    this.element.remove();
  }

  private toggleNewTabOptions(): void {
    if (this.noticeKind === 'options') {
      this.closeNotice();
      return;
    }
    const saved = this.callbacks.hasNewTabPanels();

    const desc = document.createElement('p');
    desc.className = 'tab-cap-notice-desc';
    desc.id = 'dashboard-tab-options-desc';
    desc.textContent = t(saved ? 'dashboardTabs.newTabStartsSaved' : 'dashboardTabs.newTabStartsDefault');

    const hint = document.createElement('p');
    hint.className = 'tab-cap-notice-desc';
    hint.textContent = t('dashboardTabs.newTabOptionsHint');

    const action = (label: string, run: () => void): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'tab-cap-notice-action';
      btn.textContent = label;
      btn.setAttribute('aria-describedby', desc.id);
      btn.addEventListener('click', () => {
        run();
        // After the callback: it re-renders the bar, which detaches and
        // re-attaches the options button and would drop focus restored earlier.
        this.closeNotice(true);
      });
      return btn;
    };
    const useTab = action(t('dashboardTabs.useThisTabPanels'), () => this.callbacks.onSaveNewTabPanels());

    const popover = document.createElement('div');
    popover.id = 'dashboard-tab-options';
    popover.className = 'tab-cap-notice';
    popover.setAttribute('role', 'group');
    popover.setAttribute('aria-label', t('dashboardTabs.newTabOptions'));
    popover.append(desc, hint, useTab);
    if (saved) {
      popover.append(action(t('dashboardTabs.useDefaultPanels'), () => this.callbacks.onClearNewTabPanels()));
    }

    this.openNotice('options', popover, useTab);
  }

  private anchorFor(_kind: NoticeKind): HTMLButtonElement | null {
    return this.optionsBtn;
  }

  private noticeAnchor(): HTMLButtonElement | null {
    return this.noticeKind ? this.anchorFor(this.noticeKind) : null;
  }

  private openNotice(kind: NoticeKind, notice: HTMLElement, focus: HTMLElement): void {
    this.closeNotice();
    const anchor = this.anchorFor(kind);
    if (!anchor) return;

    // The bar scrolls horizontally (overflow-x: auto), so an in-flow popover
    // would be clipped by it. The notice is body-anchored and positioned from
    // the button's viewport rect instead.
    document.body.appendChild(notice);
    const rect = anchor.getBoundingClientRect();
    notice.style.top = `${rect.bottom + 6}px`;
    notice.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - notice.offsetWidth - 8))}px`;

    this.notice = notice;
    this.noticeKind = kind;
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', notice.id);
    document.addEventListener('mousedown', this.onNoticeOutsideClick);
    document.addEventListener('keydown', this.onNoticeKeyDown);
    focus.focus();
  }

  private closeNotice(restoreFocus = false): void {
    if (!this.notice) return;
    const anchor = this.noticeAnchor();
    document.removeEventListener('mousedown', this.onNoticeOutsideClick);
    document.removeEventListener('keydown', this.onNoticeKeyDown);
    this.notice.remove();
    this.notice = null;
    this.noticeKind = null;
    this.optionsBtn.setAttribute('aria-expanded', 'false');
    this.optionsBtn.removeAttribute('aria-controls');
    if (restoreFocus) anchor?.focus();
  }

  private render(): void {
    this.tablistEl.replaceChildren();
    const { tabs, activeTabId } = this.getState();
    for (const tab of tabs) {
      this.tablistEl.appendChild(this.renderTab(tab, tab.id === activeTabId, tabs.length > 1));
    }
    this.updateControlledPanel(activeTabId);
    const addBtn = document.createElement('button');
    addBtn.className = 'dashboard-tab-add';
    addBtn.title = t(this.callbacks.hasNewTabPanels() ? 'dashboardTabs.addTabTitleSaved' : 'dashboardTabs.addTabTitle');
    addBtn.textContent = '+';
    addBtn.setAttribute('aria-label', t('dashboardTabs.addTab'));
    addBtn.addEventListener('click', () => this.callbacks.onAdd());
    // The tablist owns only tabs; the add and options buttons are siblings in the bar.
    const focusBtn = this.callbacks.focus ? [this.focusBtn] : [];
    if (this.callbacks.focus) {
      const focusedTab = this.callbacks.focus.isFocused();
      const label = t(focusedTab ? 'focus.tabButtonTitleActive' : 'focus.tabButtonTitle');
      this.focusBtn.classList.toggle('active', focusedTab);
      this.focusBtn.title = label;
      this.focusBtn.setAttribute('aria-label', label);
    }
    // Re-inserting a focused button blurs it; put keyboard focus back.
    const focused = [this.optionsBtn, this.focusBtn].find((btn) => btn === document.activeElement);
    this.element.replaceChildren(this.tablistEl, addBtn, this.optionsBtn, ...focusBtn, this.liveRegion);
    if (focused?.isConnected) focused.focus();
  }

  private renderTab(tab: PanelTab, isActive: boolean, canDelete: boolean): HTMLElement {
    const el = document.createElement('div');
    el.className = `dashboard-tab${isActive ? ' active' : ''}`;
    el.dataset.tabId = tab.id;

    const label = document.createElement('button');
    label.className = 'dashboard-tab-label';
    label.id = this.getTabButtonId(tab.id);
    label.setAttribute('role', 'tab');
    label.setAttribute('aria-selected', String(isActive));
    label.tabIndex = isActive ? 0 : -1;
    // ARIA tab contract: a role="tab" must point at the tabpanel it controls.
    // All tabs drive the same panel grid (only its contents swap on switch).
    label.setAttribute('aria-controls', 'panelsGrid');
    label.textContent = tab.name;
    label.title = t('dashboardTabs.renameHint', { name: tab.name });
    label.addEventListener('click', () => {
      if (!isActive) this.callbacks.onSelect(tab.id);
    });
    // dblclick-to-rename is handled by the container-level delegate in the
    // constructor so it works for inactive tabs too (see note there).
    el.appendChild(label);

    if (canDelete) {
      const close = document.createElement('button');
      close.className = 'dashboard-tab-close';
      close.setAttribute('aria-label', t('dashboardTabs.deleteTabAria', { name: tab.name }));
      close.title = t('dashboardTabs.deleteTab');
      close.textContent = '×';
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        this.callbacks.onDelete(tab.id);
      });
      el.appendChild(close);
    }
    return el;
  }

  private handleKeyDown(e: KeyboardEvent): void {
    if (!(e.target instanceof HTMLElement)) return;
    if (e.target.classList.contains('dashboard-tab-rename')) return;
    const tabs = this.getTabButtons();
    const currentIndex = tabs.indexOf(e.target.closest('[role="tab"]') as HTMLButtonElement);
    if (currentIndex === -1) return;

    let nextIndex: number | null = null;
    if (e.key === 'ArrowRight') nextIndex = (currentIndex + 1) % tabs.length;
    else if (e.key === 'ArrowLeft') nextIndex = (currentIndex - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') nextIndex = 0;
    else if (e.key === 'End') nextIndex = tabs.length - 1;
    else return;

    e.preventDefault();
    const next = tabs[nextIndex];
    const tabId = next?.closest('.dashboard-tab')?.getAttribute('data-tab-id');
    if (!next || !tabId) return;

    if (tabId !== this.getState().activeTabId) {
      this.callbacks.onSelect(tabId);
      requestAnimationFrame(() => document.getElementById(this.getTabButtonId(tabId))?.focus());
      return;
    }
    next.focus();
  }

  private getTabButtons(): HTMLButtonElement[] {
    return Array.from(this.element.querySelectorAll<HTMLButtonElement>('.dashboard-tab-label[role="tab"]'));
  }

  private getTabButtonId(tabId: string): string {
    return `dashboard-tab-${tabId.replace(/[^A-Za-z0-9_-]/g, '-')}`;
  }

  private updateControlledPanel(activeTabId: string): void {
    const panel = document.getElementById('panelsGrid');
    if (!panel) return;
    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', this.getTabButtonId(activeTabId));
  }

  private startRename(tabEl: HTMLElement, tab: PanelTab): void {
    const labelBtn = tabEl.querySelector('.dashboard-tab-label');
    if (!labelBtn || tabEl.querySelector('.dashboard-tab-rename')) return;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dashboard-tab-rename';
    input.value = tab.name;
    input.maxLength = DASHBOARD_TAB_NAME_MAX_LENGTH;
    input.setAttribute('aria-label', t('dashboardTabs.tabNameAria'));

    // `done` guards the blur that fires when commit/cancel re-renders the bar.
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = input.value.trim();
      if (name && name !== tab.name) this.callbacks.onRename(tab.id, name);
      else this.render();
    };
    const cancel = () => {
      if (done) return;
      done = true;
      this.render();
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') commit();
      else if (e.key === 'Escape') cancel();
      e.stopPropagation();
    });
    input.addEventListener('blur', commit);

    labelBtn.replaceWith(input);
    input.focus();
    input.select();
  }
}
