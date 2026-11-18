import { PERSONAL_MODE } from '@/config/personal-mode';
import { CANONICAL_FEEDS, INTEL_SOURCES, SOURCE_REGION_MAP } from '@/config/feeds';
import { WEB_APP_ORIGIN } from '@/config/web-origin';
import { openExternalUrl } from '@/services/external-navigation';
import { THEATER_PRESETS, getTheaterPreset, getTheaterPresetEnableList, resolveTheaterPresetSources, type TheaterPreset } from '@/config/theater-presets';
import {
  PANEL_CATEGORY_MAP,
  ALL_PANELS,
  getEffectivePanelConfig,
  getVariantPanelCategories,
  isPanelInVariantDefaults,
} from '@/config/panels';
import { SITE_VARIANT } from '@/config/variant';
import { I18N_RESOURCES_LOADED_EVENT, t } from '@/services/i18n';
import { replaceRawI18nKeyPlaceholders } from '@/utils/i18n-raw-key-healer';
import { createSettingsButton } from '@/components/settings-button';
import { confirmDialog } from '@/components/confirm-dialog';
import {
  getPanelToggleA11yState,
  restoreSettingsToggleFocus,
} from '@/components/unified-settings-interactions';
import {
  buildNav,
  diffNav,
  isPreferenceSection,
  isSettingsSectionId,
  pageEntryEffect,
  reduceNav,
  searchNav,
  searchTerms,
  sectionLabelKey,
  type MountedSection,
  type NavEvent,
  type NavGroup,
  type NavLayout,
  type NavState,
  type PreferenceSectionId,
  type RowSummary,
  type SectionMount,
  type SettingsFacts,
  type SettingsSectionId,
  type ShellSectionId,
} from '@/config/settings-sections';
import { getThemePreference } from '@/utils/theme-manager';
import type { MapProvider } from '@/config/basemap';
import { escapeHtml } from '@/utils/sanitize';
import { safeStorageRemove, safeStorageSet } from '@/utils/safe-storage';
import type { PanelConfig } from '@/types';
import { renderPreferenceSection } from '@/services/preferences-content';
import { mountInstallEntry } from '@/services/pwa-install';
import { renderNotificationsSettings } from '@/services/notifications-settings';
import { getAuthState, subscribeAuthState } from '@/services/auth-state';
import { isClerkAuthEnabled, signOut } from '@/services/clerk';
import { requestOwnAccountDeletion } from '@/services/account-deletion';
import { track } from '@/services/analytics';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';
import { legalLinksHtml, LEGAL_LINK_ATTR } from '@/utils/legal-links';
import { dashboardSiteLinksHtml } from '@/utils/dashboard-site-links';
import { resolveDashboardSiteOrigin } from '@/config/dashboard-reference-links';
import { createFocusTrap, type FocusTrap } from '@/utils/focus-trap';
import {
  overlayHistory,
  type OverlayCloseOrigin,
  type OverlayId,
  type OverlayOpenHandle,
} from '@/utils/overlay-history';
import { isMobileDevice } from '@/utils';
import {
  FONT_SCALE_STEPS,
  fontScaleLabel,
  panelFontScaleSummary,
  parseFontScale,
} from '@/services/font-scale-settings';
import { showToast } from '@/utils/toast';
import { declareOverlay } from '@/utils/open-modal';

export interface UnifiedSettingsConfig {
  getPanelSettings: () => Record<string, PanelConfig>;
  savePanelSettings: (panels: Record<string, PanelConfig>) => void;
  getDisabledSources: () => Set<string>;
  toggleSource: (name: string) => void;
  setSourcesEnabled: (names: string[], enabled: boolean) => void;
  getAllSourceNames: () => string[];
  getLocalizedPanelName: (key: string, fallback: string) => string;
  resetLayout: () => void;
  isDesktopApp: boolean;
  onMapProviderChange?: (provider: MapProvider) => void;
  /**
   * The user finished editing Settings → SOURCES and the enabled set is not
   * what it was when the overlay opened.
   *
   * Sources apply to `ctx.disabledSources` on click (no draft/Save step like
   * panels), but nothing subscribed to that write, so the change only reached
   * the dashboard at the next `REFRESH_INTERVALS.feeds` tick
   * (#6380). This is the subscription.
   *
   * Fired on teardown rather than per click on purpose: the overlay covers the
   * dashboard, so nothing is observable until it closes, and a per-click
   * refetch would be a request storm while the user works through the grid
   * (the budget guarded by e2e/dashboard-news-request-budget.spec.ts). Once per
   * settings session, and only when the selection genuinely moved.
   */
  onSourcesChanged?: () => void;
}

/** What the user types to confirm account deletion. Not translated: it is a token, not prose. */
const DELETION_PHRASE = 'DELETE';

export class UnifiedSettings {
  private overlay: HTMLElement;
  private focusTrap: FocusTrap;
  private config: UnifiedSettingsConfig;
  /** Where the window is. Written only by dispatch() and rebuild(). */
  private nav: NavState | null = null;
  /** Pages mounted this session. Each mounts on first visit and stays until close. */
  private readonly pages = new Map<SettingsSectionId, { el: HTMLElement; mounted: MountedSection }>();
  /** Where the home list and each page were last scrolled this session. */
  private readonly scrollOffsets = new Map<SettingsSectionId | 'home', number>();
  /** The last page shown while this shell has lived, open or closed. The modal reopens on it. */
  private recentPage: SettingsSectionId | null = null;
  /** The sidebar search text. The sheet has no search, so it is empty there. */
  private navQuery = '';
  private installCleanup: (() => void) | null = null;
  private legalLinkHandoffAttached = false;
  private activeSourceRegion = 'all';
  private sourceFilter = '';
  private activePanelCategory = 'all';
  private panelFilter = '';
  private escapeHandler: (e: KeyboardEvent) => void;
  private draftPanelSettings: Record<string, PanelConfig> = {};
  private panelsJustSaved = false;
  private savedTimeout: ReturnType<typeof setTimeout> | null = null;
  private confirmingClose = false;
  /** Runs once Settings has actually closed; dropped when the user keeps it open. */
  private afterTeardown: (() => void) | null = null;
  private historyRegistered = false;
  /** The open page's history entry on the phone sheet, from request until it closes. */
  private pageEntry: OverlayOpenHandle | null = null;
  /**
   * `sourceSelectionSignature()` as of the last open(), or null while closed.
   *
   * A signature rather than a "something was toggled" flag: a source click can
   * legitimately fail to mutate anything (the free-tier cap toasts and returns
   * without touching the set), and toggling a source off and back on again is a
   * net no-op the dashboard must not be asked to reload for.
   */
  private sourceSelectionBaseline: string | null = null;
  private accountUserId: string | null = getAuthState().user?.id ?? null;
  private unsubscribeAuth: (() => void) | null = null;
  private deletionDialog: HTMLElement | null = null;
  private deletionFocusTrap: FocusTrap | null = null;
  private deletionBusy = false;
  private deletionError = '';
  private deletionPhraseHandler: (() => void) | null = null;

  constructor(config: UnifiedSettingsConfig) {
    this.config = config;

    this.overlay = document.createElement('div');
    this.overlay.className = 'modal-overlay';
    this.overlay.id = 'unifiedSettingsModal';
    this.overlay.setAttribute('role', 'dialog');
    this.overlay.setAttribute('aria-modal', 'true');
    declareOverlay(this.overlay, { reload: 'blocking' });
    this.overlay.setAttribute('aria-label', t('header.settings'));
    this.focusTrap = createFocusTrap(this.overlay);

    this.resetPanelDraft();

    this.escapeHandler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (this.deletionDialog) {
          e.stopPropagation();
          if (!this.deletionBusy) this.closeDeletionDialog();
          return;
        }
        this.close();
      }
    };

    this.overlay.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;

      if (this.deletionDialog) return;

      if (target === this.overlay) {
        this.close();
        return;
      }

      if (target.closest('.unified-settings-close')) {
        this.close();
        return;
      }

      if (target.closest('[data-delete-account]')) {
        this.openDeletionDialog();
        return;
      }

      const section = target.closest<HTMLElement>('[data-settings-nav]')?.dataset.settingsNav;
      if (isSettingsSectionId(section)) {
        this.dispatch({ type: 'select', id: section });
        return;
      }

      if (target.closest('[data-settings-back]')) {
        this.dispatch({ type: 'back' });
        return;
      }

      const signOutButton = target.closest<HTMLButtonElement>('[data-settings-signout]');
      if (signOutButton) {
        // The auth subscription rebuilds Settings for the signed-out state.
        signOutButton.disabled = true;
        signOut().catch(() => {
          signOutButton.disabled = false;
          showToast(t('settings.signOutFailed'));
        });
        return;
      }

      if (target.closest('[data-settings-signin]')) {
        this.afterTeardown = () => { import('@/services/clerk').then(m => m.openSignIn()).catch(() => {}); };
        this.close();
        return;
      }

      const panelCatPill = target.closest<HTMLElement>('[data-panel-cat]');
      if (panelCatPill?.dataset.panelCat) {
        this.activePanelCategory = panelCatPill.dataset.panelCat;
        this.panelFilter = '';
        const searchInput = this.overlay.querySelector<HTMLInputElement>('.panels-search input');
        if (searchInput) searchInput.value = '';
        this.renderPanelCategoryPills();
        this.renderPanelsTab();
        return;
      }

      if (target.closest('.panels-reset-layout')) {
        this.config.resetLayout();
        return;
      }

      if (target.closest('.panels-save-layout')) {
        this.savePanelChanges();
        this.refreshSummaries();
        return;
      }

      const panelItem = target.closest<HTMLElement>('.panel-toggle-item');
      if (panelItem?.dataset.panel) {
        const panelKey = panelItem.dataset.panel;
        const shouldRestoreFocus = document.activeElement === panelItem;
        this.toggleDraftPanel(panelKey);
        this.refreshSummaries();
        restoreSettingsToggleFocus(
          shouldRestoreFocus,
          this.overlay.querySelectorAll<HTMLElement>('.panel-toggle-item'),
          'panel',
          panelKey,
        );
        return;
      }

      const sourceItem = target.closest<HTMLElement>('.source-toggle-item');
      if (sourceItem?.dataset.source) {
        const sourceName = sourceItem.dataset.source;
        const shouldRestoreFocus = document.activeElement === sourceItem;
        this.config.toggleSource(sourceName);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        this.refreshSummaries();
        restoreSettingsToggleFocus(
          shouldRestoreFocus,
          this.overlay.querySelectorAll<HTMLElement>('.source-toggle-item'),
          'source',
          sourceName,
        );
        return;
      }

      const pill = target.closest<HTMLElement>('.unified-settings-region-pill');
      if (pill?.dataset.region) {
        this.activeSourceRegion = pill.dataset.region;
        this.sourceFilter = '';
        const searchInput = this.overlay.querySelector<HTMLInputElement>('.sources-search input');
        if (searchInput) searchInput.value = '';
        this.renderRegionPills();
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        return;
      }

      if (target.closest('.sources-select-all')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, true);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        this.refreshSummaries();
        return;
      }

      const presetChip = target.closest<HTMLElement>('.unified-settings-preset-chip');
      if (presetChip?.dataset.presetId) {
        this.applyCoveragePreset(presetChip.dataset.presetId);
        return;
      }

      if (target.closest('.sources-select-none')) {
        const visible = this.getVisibleSourceNames();
        this.config.setSourcesEnabled(visible, false);
        this.renderSourcesGrid();
        this.updateSourcesCounter();
        this.refreshSummaries();
        return;
      }

    });

    this.overlay.addEventListener('change', (e) => {
      const select = (e.target as HTMLElement).closest<HTMLSelectElement>('[data-panel-font-scale]');
      const panelKey = select?.dataset.panelFontScale;
      if (!select || !panelKey) return;
      const panel = this.draftPanelSettings[panelKey];
      if (!panel) return;

      if (select.value === 'global') {
        delete panel.fontScale;
      } else {
        const scale = parseFontScale(select.value);
        if (scale === undefined) {
          select.value = panel.fontScale === undefined ? 'global' : String(panel.fontScale);
          return;
        }
        panel.fontScale = scale;
      }

      const row = select.closest('.panel-settings-item');
      const scaleSummary = row?.querySelector('[data-panel-scale-summary]');
      if (scaleSummary) scaleSummary.textContent = panelFontScaleSummary(panel.fontScale);
      this.panelsJustSaved = false;
      row
        ?.querySelector('.panel-toggle-item')
        ?.classList.toggle(
          'changed',
          this.isPanelDraftChanged(panelKey, panel, this.config.getPanelSettings()),
        );
      this.updatePanelsFooter();
    });

    this.overlay.addEventListener('input', (e) => {
      const target = e.target as HTMLInputElement;
      if (target.matches('[data-settings-search]')) {
        this.navQuery = target.value;
        this.renderHome();
      } else if (target.closest('.panels-search')) {
        this.panelFilter = target.value;
        this.renderPanelsTab();
      } else if (target.closest('.sources-search')) {
        this.sourceFilter = target.value;
        this.renderSourcesGrid();
        this.updateSourcesCounter();
      }
    });

    // Kept as the reader scrolls: by the time a breakpoint crossing reaches
    // onResize, the old layout's scroller has already lost its offset.
    this.overlay.addEventListener('scroll', (e) => {
      if (this.nav && e.target === this.scroller(this.nav)) {
        this.scrollOffsets.set(this.nav.page ?? 'home', this.scroller(this.nav).scrollTop);
      }
    }, { capture: true, passive: true });

    // Escape in a non-empty sidebar search clears it; the next Escape reaches
    // escapeHandler on the document and closes Settings.
    this.overlay.addEventListener('keydown', (e) => {
      const target = e.target as HTMLInputElement;
      if (e.key !== 'Escape' || !target.matches('[data-settings-search]') || target.value === '') return;
      e.stopPropagation();
      this.clearSearch();
    });

    this.renderFrame();
    document.body.appendChild(this.overlay);
    this.unsubscribeAuth = subscribeAuthState((state) => {
      this.handleAccountIdentityChange(state.user?.id ?? null);
    });
  }

  private handleAccountIdentityChange(nextUserId: string | null): void {
    if (nextUserId === this.accountUserId) return;

    this.closeDeletionDialog();
    this.accountUserId = nextUserId;

    // Rebuild account-scoped pages for the new identity.
    if (this.overlay.classList.contains('active')) {
      this.rebuild(false);
    }
  }

  public open(section?: SettingsSectionId, replaceOverlayId?: OverlayId): void {
    if (PERSONAL_MODE && section === 'account') section = undefined;
    const reentrant = this.overlay.classList.contains('active');
    this.resetPanelDraft();
    // Only on a FRESH session. open() is re-entrant on an overlay that is
    // already up (the deep-dive "Notify me about this country" jump to the
    // notifications page, an overlayHistory replace), and re-snapshotting there
    // would adopt a source change already made in this session as the baseline
    // — silently discarding the very reload this exists to trigger.
    if (this.sourceSelectionBaseline === null) {
      this.sourceSelectionBaseline = this.sourceSelectionSignature();
    }
    if (reentrant) {
      this.renderPanelsTab();
    } else {
      this.startSession();
    }
    this.overlay.classList.add('active');
    this.focusTrap.activate();
    if (isMobileDevice()) {
      this.historyRegistered = true;
      const close = (origin: OverlayCloseOrigin) => this.close(origin);
      if (replaceOverlayId) overlayHistory.replace(replaceOverlayId, 'settings', close);
      else overlayHistory.open('settings', close);
    }
    // After the Settings entry: a page opened directly stacks its entry above
    // it, so Back from that page lands on the home list.
    this.dispatch({ type: 'open', target: section, layout: isMobileDevice() ? 'sheet' : 'modal', recent: this.recentPage });
    safeStorageSet('wm-settings-open', '1');
    document.addEventListener('keydown', this.escapeHandler);
    window.addEventListener('resize', this.onResize);
    window.addEventListener(I18N_RESOURCES_LOADED_EVENT, this.onTranslationsLoaded);
    track('settings-open', { tab: section ?? 'default' });

  }

  public close(origin: OverlayCloseOrigin = 'control'): void {
    if (origin === 'history') this.historyRegistered = false;
    // An in-flight deletion owns the overlay until it settles. The overlay
    // click handler and escapeHandler already refuse while deletionBusy is
    // set; without this guard the mobile back gesture reaches teardownSettings
    // -> closeDeletionDialog, which clears the latch mid-await and re-permits
    // a second confirmAccountDeletion against the same account. Re-arm the
    // history entry the gesture just consumed, matching the unsaved-changes
    // branch below, so a later back press still closes the overlay. This sits
    // after the flag is cleared above, because that is what makes the
    // re-registration condition reachable.
    if (this.deletionBusy) {
      this.afterTeardown = null;
      if (origin === 'history' && !this.historyRegistered) {
        this.historyRegistered = true;
        overlayHistory.open('settings', (nextOrigin) => this.close(nextOrigin));
      }
      return;
    }
    // Unsaved panel changes → confirm before tearing down. The confirm is a
    // non-blocking in-app dialog (#4559): close() stays synchronous (8 callers)
    // and defers teardown to the user's choice instead of a blocking confirm().
    if (origin !== 'replacement' && this.hasPendingPanelChanges()) {
      if (origin === 'history' && !this.historyRegistered) {
        this.historyRegistered = true;
        overlayHistory.open('settings', (nextOrigin) => this.close(nextOrigin));
      }
      if (this.confirmingClose) return; // a confirm is already on screen
      this.confirmingClose = true;
      void confirmDialog({ message: t('header.unsavedChanges') }).then((discard) => {
        this.confirmingClose = false;
        if (discard) this.teardownSettings('control');
        else this.afterTeardown = null;
      });
      return;
    }
    this.teardownSettings(origin);
  }

  public hasPendingChanges(): boolean {
    return this.hasPendingPanelChanges();
  }

  private teardownSettings(origin: OverlayCloseOrigin = 'control'): void {
    this.releasePageEntry();
    if (origin === 'control' && this.historyRegistered) {
      overlayHistory.close('settings');
    }
    this.historyRegistered = false;
    this.overlay.classList.remove('active');
    this.focusTrap.deactivate();
    this.endSession();
    this.closeDeletionDialog();
    this.resetPanelDraft();
    safeStorageRemove('wm-settings-open');
    document.removeEventListener('keydown', this.escapeHandler);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener(I18N_RESOURCES_LOADED_EVENT, this.onTranslationsLoaded);
    // Last: the host reloads data in response, and the overlay covering the
    // dashboard has to be gone before that lands for the user to see it.
    this.notifySourceSelectionChanged();
    const afterTeardown = this.afterTeardown;
    this.afterTeardown = null;
    afterTeardown?.();
  }

  /**
   * Order-independent fingerprint of the currently DISABLED source names.
   *
   * NUL is the separator because source names contain spaces ("BBC World"):
   * any separator a name can itself hold collapses `["A B"]` and `["A", "B"]`
   * into one string, which is a silent miss for exactly the swap-one-source-
   * for-another case this comparison exists to catch.
   */
  private sourceSelectionSignature(): string {
    return [...this.config.getDisabledSources()].sort().join('\u0000');
  }

  /**
   * Tell the host the source selection moved during this settings session.
   *
   * Every close path funnels through teardownSettings — the close button, Esc,
   * the overlay backdrop, mobile history back, and the discard branch of the
   * unsaved-panel-changes confirm — so this is the single chokepoint. `destroy()`
   * deliberately does not reach it: the dashboard is going away.
   */
  private notifySourceSelectionChanged(): void {
    const baseline = this.sourceSelectionBaseline;
    this.sourceSelectionBaseline = null;
    // null baseline = never opened. A teardown without an open has no session
    // to compare against, and firing there would reload on a spurious close.
    if (baseline === null || baseline === this.sourceSelectionSignature()) return;
    this.config.onSourcesChanged?.();
  }

  public refreshPanelToggles(): void {
    this.resetPanelDraft();
    this.renderPanelsTab();
    this.refreshSummaries();
  }

  public getButton(): HTMLButtonElement {
    return createSettingsButton(() => this.open());
  }

  public destroy(): void {
    this.releasePageEntry();
    if (this.historyRegistered) overlayHistory.close('settings');
    this.historyRegistered = false;
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.endSession();
    this.unsubscribeAuth?.();
    this.unsubscribeAuth = null;
    this.closeDeletionDialog();
    document.removeEventListener('keydown', this.escapeHandler);
    window.removeEventListener('resize', this.onResize);
    window.removeEventListener(I18N_RESOURCES_LOADED_EVENT, this.onTranslationsLoaded);
    // Teardown, not a user-initiated close: release the trap's document
    // listener without handing focus back to a trigger that is also going away.
    this.focusTrap.deactivate({ restoreFocus: false });
    this.overlay.remove();
  }

  // ---------------------------------------------------------------------------
  // Shell: home list, drill-in pages and the one navigation writer
  // ---------------------------------------------------------------------------

  /** Builds the persistent frame once. Pages and home rows fill it per session. */
  private renderFrame(): void {
    setTrustedHtml(this.overlay, trustedHtml(`
      <div class="modal unified-settings-modal" data-settings-depth="home">
        <div class="modal-header">
          <button type="button" class="us-back" data-settings-back hidden aria-label="${escapeHtml(t('settings.back'))}"><span aria-hidden="true">‹</span> ${escapeHtml(t('header.tabSettings'))}</button>
          <span class="modal-title" data-settings-title>${escapeHtml(t('header.settings'))}</span>
          <button class="modal-close unified-settings-close" aria-label="Close">×</button>
        </div>
        <nav class="us-home" data-settings-home aria-label="${escapeHtml(t('header.tabSettings'))}">
          <div class="us-search">
            <input type="search" class="us-search-input" data-settings-search autocomplete="off" spellcheck="false"
              placeholder="${escapeHtml(t('modals.settingsWindow.shellSearchPlaceholder'))}" aria-label="${escapeHtml(t('modals.settingsWindow.shellSearchPlaceholder'))}" aria-controls="us-home-rows">
          </div>
          ${this.config.isDesktopApp ? '' : '<div class="us-install-slot" data-pwa-install-entry></div>'}
          <div class="us-home-rows" id="us-home-rows" data-settings-rows></div>
          <p class="us-search-empty" data-settings-empty aria-live="polite"></p>
        </nav>
        <div class="us-pages" data-settings-pages></div>
      </div>
    `, 'settings frame; static markup and escaped translations'));
  }

  private startSession(): void {
    this.endSession();
    this.scrollOffsets.clear();
    this.clearSearch();
    this.attachLegalLinkHandoff();
    const installHost = this.overlay.querySelector<HTMLElement>('[data-pwa-install-entry]');
    if (installHost) this.installCleanup = mountInstallEntry(installHost);
  }

  /** Disposes every mounted page and returns to no navigation state. */
  private endSession(): void {
    this.disposePages();
    this.nav = null;
    this.installCleanup?.();
    this.installCleanup = null;
    this.reflectNav();
  }

  private readFacts(): SettingsFacts {
    const user = getAuthState().user;
    return {
      signedIn: user !== null,
      canSignIn: isClerkAuthEnabled(),
      isDesktopApp: this.config.isDesktopApp,
      account: user ? { plan: '', email: user.email } : null,
      panels: this.panelCounts(),
      sourcesOn: (() => {
        const disabled = this.config.getDisabledSources();
        return this.config.getAllSourceNames().filter((name) => !disabled.has(name)).length;
      })(),
      theme: getThemePreference(),
    };
  }

  /** The panels that read as on in the Panels page, out of every panel it lists. */
  private panelCounts(): { on: number; total: number } {
    const entries = this.listedPanelEntries();
    const on = entries.filter(([, panel]) => panel.enabled).length;
    return { on, total: entries.length };
  }

  private formatSummary(summary: RowSummary): string {
    switch (summary.kind) {
      case 'count':
        return t('settings.summary.count', { on: String(summary.on), total: String(summary.total) });
      case 'total':
        return new Intl.NumberFormat().format(summary.count);
      case 'text':
        return t(summary.key);
      case 'account':
        return [summary.plan, summary.email].filter(Boolean).join(' · ');
    }
  }

  /** Renders the home rows, or on the modal the sidebar rows that match its search. */
  private renderHome(): void {
    const rows = this.overlay.querySelector<HTMLElement>('[data-settings-rows]');
    if (!rows) return;
    const facts = this.readFacts();
    const { groups, hits } = searchNav(buildNav(facts), this.navQuery, searchTerms(t));
    setTrustedHtml(rows, trustedHtml(
      groups.map((group) => this.renderNavGroup(group)).join(''),
      'settings home rows; every interpolated value escaped',
    ));
    const empty = this.overlay.querySelector<HTMLElement>('[data-settings-empty]');
    if (empty) empty.textContent = this.navQuery.trim() !== '' && hits === 0 ? t('settings.search.empty') : '';
    this.markCurrentRow();
  }

  /** The modal's sidebar marks the open page's row; the sheet's list is never beside a page. */
  private markCurrentRow(): void {
    const current = this.nav?.layout === 'modal' ? this.nav.page : null;
    for (const row of this.overlay.querySelectorAll<HTMLElement>('[data-settings-nav]')) {
      if (row.dataset.settingsNav === current) row.setAttribute('aria-current', 'page');
      else row.removeAttribute('aria-current');
    }
  }

  private renderNavGroup(group: NavGroup): string {
    const rows = group.rows.map((row) => {
      if (PERSONAL_MODE && (row.kind === 'sign-in' || ('id' in row && row.id === 'account'))) return '';
      if (row.kind === 'sign-in') {
        return `
          <button type="button" class="us-account-card us-signin-row" data-settings-signin>
            <span class="us-avatar" aria-hidden="true"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="8" r="4"/><path d="M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6"/></svg></span>
            <span class="us-row-text">
              <span class="us-row-title">${escapeHtml(t('settings.signIn.label'))}</span>
              <span class="us-row-desc">${escapeHtml(t('settings.signIn.desc'))}</span>
            </span>
            <span class="us-row-chev" aria-hidden="true">›</span>
          </button>`;
      }
      const summary = row.summary ? escapeHtml(this.formatSummary(row.summary)) : '';
      const title = escapeHtml(t(row.labelKey));
      if (row.id === 'account') {
        return `
          <button type="button" class="us-account-card" data-settings-nav="account" id="us-nav-account">
            <span class="us-avatar" aria-hidden="true">${escapeHtml(this.accountInitials())}</span>
            <span class="us-row-text">
              <span class="us-row-title">${title}</span>
              <span class="us-row-desc" data-settings-summary>${summary}</span>
            </span>
            <span class="us-row-chev" aria-hidden="true">›</span>
          </button>`;
      }
      return `
        <li>
          <button type="button" class="us-row" data-settings-nav="${row.id}" id="us-nav-${row.id}">
            <span class="us-row-text">
              <span class="us-row-title">${title}${row.badge ? ' <span class="panel-pro-badge">PRO</span>' : ''}</span>
              ${row.descKey ? `<span class="us-row-desc">${escapeHtml(t(row.descKey))}</span>` : ''}
            </span>
            ${row.summary ? `<span class="us-row-value" data-settings-summary>${summary}</span>` : ''}
            <span class="us-row-chev" aria-hidden="true">›</span>
          </button>
        </li>`;
    }).join('');
    if (group.labelKey === null) return rows;
    const headingId = `us-group-${group.id}`;
    return `
      <section class="us-group" aria-labelledby="${headingId}">
        <h3 class="us-group-label" id="${headingId}">${escapeHtml(t(group.labelKey))}</h3>
        <ul class="us-list" role="list">${rows}</ul>
      </section>`;
  }

  private accountInitials(): string {
    const user = getAuthState().user;
    const source = user?.name?.trim() || user?.email || '';
    const words = source.split(/[\s@._-]+/).filter(Boolean);
    return words.slice(0, 2).map((word) => word.charAt(0).toUpperCase()).join('') || '?';
  }

  /** Patches each home row's summary in place, so a toggle never re-renders the list. */
  private refreshSummaries(): void {
    if (!this.overlay.classList.contains('active')) return;
    for (const group of buildNav(this.readFacts())) {
      for (const row of group.rows) {
        if (row.kind !== 'section' || !row.summary) continue;
        const el = this.overlay.querySelector(`[data-settings-nav="${row.id}"] [data-settings-summary]`);
        if (el) el.textContent = this.formatSummary(row.summary);
      }
    }
  }

  /** The single writer of navigation state. Effects come only from diffNav. */
  private dispatch(ev: NavEvent): void {
    const prev = this.nav;
    const next = reduceNav(prev, ev, this.readFacts());
    if (next === prev) {
      this.syncPageEntry();
      return;
    }
    const fx = diffNav(prev, next);
    // A relayout keeps the page, and the old layout's scroller no longer
    // holds its offset, so only a page change records one here. The scroll
    // listener has the offset from before the crossing.
    const pageChanged = prev === null || fx.enter !== null || fx.leave !== null;
    if (prev && pageChanged) this.scrollOffsets.set(prev.page ?? 'home', this.scroller(prev).scrollTop);
    this.nav = next;
    if (next.page !== null) this.recentPage = next.page;
    if (fx.leave) this.pages.get(fx.leave)?.mounted.leave?.();
    const entered = fx.enter ? this.ensurePage(fx.enter) : null;
    // Search belongs to the modal's sidebar; the sheet lists every row.
    if (next.layout === 'sheet' && this.navQuery !== '') this.clearSearch();
    this.reflectNav();
    // The phone sheet is a drill-in stack, so a page opens at its top there.
    // The home list, and every page in the modal, return to where they were left.
    if (pageChanged) {
      const drillIn = next.layout === 'sheet' && next.page !== null;
      this.scroller(next).scrollTop = drillIn ? 0 : this.scrollOffsets.get(next.page ?? 'home') ?? 0;
    } else if (ev.type === 'relayout') {
      this.scroller(next).scrollTop = this.scrollOffsets.get(next.page ?? 'home') ?? 0;
    }
    entered?.mounted.enter?.();
    // The sidebar keeps focus on the row a user picked; elsewhere the page heading takes it.
    const focusHeading = ev.type === 'open' || (ev.type === 'select' && next.layout === 'sheet');
    // A relayout can hide the focused control: the sidebar search, or the sheet's Back.
    const focused = document.activeElement;
    const focusLost = ev.type === 'relayout' && focused instanceof HTMLElement
      && this.overlay.contains(focused) && focused.closest('[hidden]') !== null;
    if (entered && focusHeading) {
      entered.el.querySelector<HTMLElement>('.us-page-title')?.focus({ preventScroll: true });
    } else if (focusLost && next.page !== null) {
      this.pages.get(next.page)?.el.querySelector<HTMLElement>('.us-page-title')?.focus({ preventScroll: true });
    } else if (fx.leave && next.page === null) {
      this.overlay.querySelector<HTMLElement>(`[data-settings-nav="${fx.leave}"]`)?.focus({ preventScroll: true });
    }
    this.syncPageEntry();
  }

  /** The layout the viewport calls for. Settings follows it on open and on resize. */
  private navLayout(): NavLayout {
    return isMobileDevice() ? 'sheet' : 'modal';
  }

  /**
   * Settings can open before the full catalogue loads (a deep link, or the
   * checkout return opening Account), and its keys are not in the boot shell.
   * Redraw the rows and heal the open pages in place, so typed input survives.
   */
  private readonly onTranslationsLoaded = (): void => {
    this.renderHome();
    replaceRawI18nKeyPlaceholders(this.overlay, t);
    // The deletion dialog sits on document.body, outside the overlay.
    if (this.deletionDialog) {
      replaceRawI18nKeyPlaceholders(this.deletionDialog, t);
      const label = this.deletionDialog.querySelector('.account-deletion-dialog-label');
      if (label) label.textContent = t('settings.account.deletion.phraseLabel', { phrase: DELETION_PHRASE });
    }
  };

  /**
   * Crossing the phone breakpoint redraws Settings in the other layout on the
   * same page. Settings opened in the desktop modal has no history entry, so a
   * window narrowed to the phone sheet registers it first.
   */
  private readonly onResize = (): void => {
    if (!this.historyRegistered && this.navLayout() === 'sheet') {
      this.historyRegistered = true;
      overlayHistory.open('settings', (origin) => this.close(origin));
    }
    this.dispatch({ type: 'relayout', layout: this.navLayout(), recent: this.recentPage });
  };

  /** The sheet scrolls as a whole; the modal scrolls its page pane beside a fixed sidebar. */
  private scroller(nav: NavState): HTMLElement {
    const selector = nav.layout === 'modal' ? '[data-settings-pages]' : '.unified-settings-modal';
    return this.overlay.querySelector<HTMLElement>(selector)!;
  }

  /** Empties the sidebar search and lists every row again. */
  private clearSearch(): void {
    this.navQuery = '';
    const search = this.overlay.querySelector<HTMLInputElement>('[data-settings-search]');
    if (search) search.value = '';
    this.renderHome();
  }

  /** Holds or releases the open page's history entry to match the page and layout. Idempotent. */
  private syncPageEntry(): void {
    if (pageEntryEffect(this.nav, this.historyRegistered) === 'hold') {
      this.pageEntry ??= overlayHistory.openCancelable('settings-section', this.onPageEntryClosed);
    } else {
      this.releasePageEntry();
    }
  }

  private releasePageEntry(): void {
    this.pageEntry?.cancel();
    this.pageEntry = null;
    overlayHistory.close('settings-section');
  }

  /** The manager removed the page entry: device Back, or the tab bar replacing Settings. */
  private readonly onPageEntryClosed = (origin: OverlayCloseOrigin): void => {
    this.pageEntry = null;
    // A replacement is the tab bar dismissing or replacing Settings next.
    if (origin !== 'history') return;
    // Back with the deletion dialog up acts like Escape: it closes the dialog
    // (never mid-deletion) and keeps the Account page.
    if (this.deletionDialog) {
      if (!this.deletionBusy) this.closeDeletionDialog();
      this.syncPageEntry();
      return;
    }
    this.dispatch({ type: 'back' });
  };

  /**
   * Account or entitlement change: every page may render differently, so
   * remount them all. The current page stays if it is still available.
   */
  private rebuild(runEnter: boolean): void {
    const focusWasInside = this.overlay.contains(document.activeElement);
    const before = this.nav?.page ?? null;
    const offset = this.nav ? this.scroller(this.nav).scrollTop : 0;
    this.disposePages();
    this.nav = reduceNav(this.nav, { type: 'facts-changed' }, this.readFacts());
    if (this.nav.page !== null) this.recentPage = this.nav.page;
    this.renderHome();
    const page = this.nav.page ? this.ensurePage(this.nav.page) : null;
    this.reflectNav();
    // Removing the old page can clamp the scroller's offset. A reader who
    // stays on the same page keeps their place.
    this.scroller(this.nav).scrollTop = this.nav.page === before ? offset : this.scrollOffsets.get(this.nav.page ?? 'home') ?? 0;
    if (runEnter) page?.mounted.enter?.();
    if (focusWasInside && !this.overlay.contains(document.activeElement)) {
      const target = page?.el.querySelector<HTMLElement>('.us-page-title')
        ?? this.overlay.querySelector<HTMLElement>('[data-settings-nav], [data-settings-signin]');
      target?.focus({ preventScroll: true });
    }
    this.syncPageEntry();
  }

  /**
   * Shows what the state says. The sheet shows the home list or one page
   * under a back button; the modal shows its sidebar beside the page.
   */
  private reflectNav(): void {
    const page = this.nav?.page ?? null;
    const sidebar = this.nav?.layout === 'modal';
    const homeShown = sidebar || page === null;
    const home = this.overlay.querySelector<HTMLElement>('[data-settings-home]');
    if (home) home.hidden = !homeShown;
    for (const [id, mounted] of this.pages) mounted.el.hidden = id !== page;
    const back = this.overlay.querySelector<HTMLElement>('[data-settings-back]');
    if (back) back.hidden = sidebar || page === null;
    const title = this.overlay.querySelector<HTMLElement>('[data-settings-title]');
    if (title) title.hidden = page !== null;
    const modal = this.overlay.querySelector<HTMLElement>('.unified-settings-modal');
    if (modal) modal.dataset.settingsDepth = page === null ? 'home' : 'page';
    this.markCurrentRow();
    if (homeShown) this.refreshSummaries();
  }

  private ensurePage(id: SettingsSectionId): { el: HTMLElement; mounted: MountedSection } {
    const existing = this.pages.get(id);
    if (existing) return existing;
    const el = document.createElement('section');
    el.className = 'us-page';
    el.id = `us-page-${id}`;
    el.dataset.settingsPage = id;
    el.setAttribute('aria-labelledby', `us-page-${id}-title`);
    el.hidden = true;
    setTrustedHtml(el, trustedHtml(
      `<h2 class="us-page-title" id="us-page-${id}-title" tabindex="-1">${escapeHtml(t(sectionLabelKey(id)))}</h2>`
      + '<div class="us-page-body" data-settings-body></div>',
      'settings page frame; escaped translation',
    ));
    this.overlay.querySelector('[data-settings-pages]')?.append(el);
    const body = el.querySelector<HTMLElement>('[data-settings-body]')!;
    const page = { el, mounted: this.mountFor(id)(body) };
    this.pages.set(id, page);
    return page;
  }

  private disposePages(): void {
    for (const page of this.pages.values()) {
      page.mounted.dispose();
      page.el.remove();
    }
    this.pages.clear();
  }

  private mountFor(id: SettingsSectionId): SectionMount {
    return isPreferenceSection(id) ? this.mountPreference(id) : this.shellMounts[id];
  }

  private mountPreference(id: PreferenceSectionId): SectionMount {
    return (body) => {
      const section = renderPreferenceSection(id, {
        isDesktopApp: this.config.isDesktopApp,
        onMapProviderChange: this.config.onMapProviderChange,
        onSettingSaved: () => {
          showToast(t('modals.settingsWindow.saved'));
          // The modal's sidebar stays in view, so its summaries follow at once.
          this.refreshSummaries();
        },
        isSignedIn: getAuthState().user !== null,
      });
      setTrustedHtml(body, trustedHtml(section.html, 'preference section; the renderer escapes every value'));
      return { dispose: section.attach(body) };
    };
  }

  /** One page body per shell section. Keyed by the registry, so a missing page fails the build. */
  private readonly shellMounts: { readonly [K in ShellSectionId]: SectionMount } = {
    account: (body) => {
      setTrustedHtml(body, trustedHtml(`
        <div class="billing-settings-intro">
          <h3>${escapeHtml(t('auth.planBilling'))}</h3>
          <p>${escapeHtml(t('settings.account.intro'))}</p>
        </div>
        <ul class="us-list us-signout" role="list">
          <li><button type="button" class="us-row" data-settings-signout><span class="us-row-text"><span class="us-row-title">${escapeHtml(t('settings.signOut'))}</span></span></button></li>
        </ul>
        ${this.renderAccountDeletionSection()}
      `, 'account page; every value escaped'));
      return { dispose: () => {} };
    },
    panels: (body) => {
      setTrustedHtml(body, trustedHtml(`
        <div class="unified-settings-region-wrapper">
          <div class="unified-settings-region-bar" id="usPanelCatBar"></div>
        </div>
        <div class="panels-search">
          <input type="text" placeholder="${t('header.filterPanels')}" aria-label="${t('header.filterPanels')}" value="${escapeHtml(this.panelFilter)}" />
        </div>
        <div class="panel-toggle-grid" id="usPanelToggles"></div>
        <div class="panels-footer">
          <span class="panels-status" id="usPanelsStatus" aria-live="polite"></span>
          <button class="panels-save-layout">${t('modals.story.save')}</button>
          <button class="panels-reset-layout" title="${t('header.resetLayoutTooltip')}" aria-label="${t('header.resetLayoutTooltip')}">${t('header.resetLayout')}</button>
        </div>
      `, 'panels page; filter value escaped'));
      this.renderPanelCategoryPills();
      this.renderPanelsTab();
      return { dispose: () => {} };
    },
    sources: (body) => {
      const applicablePresets = this.getApplicableTheaterPresets();
      setTrustedHtml(body, trustedHtml(`
        <div class="unified-settings-region-wrapper">
          <div class="unified-settings-region-bar" id="usRegionBar"></div>
        </div>
        ${applicablePresets.length > 0 ? `
        <div class="unified-settings-presets" id="usCoveragePresets">
          <span class="unified-settings-presets-label">${t('theaterPresets.label')}</span>
          ${applicablePresets.map(preset =>
            `<button type="button" class="unified-settings-region-pill unified-settings-preset-chip" data-preset-id="${preset.id}" title="${escapeHtml(t(preset.descriptionKey))}">${escapeHtml(t(preset.labelKey))}</button>`
          ).join('')}
        </div>
        ` : ''}
        <div class="sources-search">
          <input type="text" placeholder="${t('header.filterSources')}" aria-label="${t('header.filterSources')}" value="${escapeHtml(this.sourceFilter)}" />
        </div>
        <div class="sources-toggle-grid" id="usSourceToggles"></div>
        <div class="sources-footer">
          <span class="sources-counter" id="usSourcesCounter"></span>
          <button class="sources-select-all">${t('common.selectAll')}</button>
          <button class="sources-select-none">${t('common.selectNone')}</button>
        </div>
      `, 'sources page; preset labels and filter value escaped'));
      const refresh = () => {
        this.renderRegionPills();
        this.renderSourcesGrid();
        this.updateSourcesCounter();
      };
      refresh();
      // A Panels save can add or remove news categories, which changes the source list.
      return { enter: refresh, dispose: () => {} };
    },
    // Mounting on first entry keeps the getChannelsData() fetch off every
    // modal open for users who never visit this page.
    notifications: (body) => {
      const notifs = renderNotificationsSettings({ isSignedIn: getAuthState().user !== null });
      setTrustedHtml(body, trustedHtml(notifs.html, 'notifications settings; the renderer escapes every value'));
      return { dispose: notifs.attach(body) };
    },
    about: (body) => {
      setTrustedHtml(body, trustedHtml(`
        <div class="us-about">
          ${dashboardSiteLinksHtml(resolveDashboardSiteOrigin({
            isDesktopApp: this.config.isDesktopApp,
            hostname: window.location.hostname,
          }))}
          ${legalLinksHtml(WEB_APP_ORIGIN)}
        </div>
      `, 'about page; link helpers escape every href'));
      return { dispose: () => {} };
    },
  };

  /**
   * Desktop hands legal links to the OS browser (#5911 precedent). A plain
   * `target="_blank"` anchor inside the Tauri WebView opens another WebView
   * window with no chrome, which is how a user ends up stranded on the Terms
   * with no way back. Delegated on the overlay so it covers the legal row AND
   * every checkout-consent line rendered inside a tab panel, including the ones
   * re-rendered after this handler is attached.
   */
  private attachLegalLinkHandoff(): void {
    if (!this.config.isDesktopApp || this.legalLinkHandoffAttached) return;
    // The overlay element outlives every re-render, so an unguarded attach
    // would stack one listener per render and open N windows on one click.
    this.legalLinkHandoffAttached = true;
    this.overlay.addEventListener('click', (e) => {
      const link = (e.target as HTMLElement | null)?.closest?.(`a[${LEGAL_LINK_ATTR}]`);
      const href = link instanceof HTMLAnchorElement ? link.href : '';
      if (!href) return;
      e.preventDefault();
      void openExternalUrl(href);
    });
  }

  private renderAccountDeletionSection(): string {
    return `
      <section class="account-deletion-zone" data-account-deletion>
        <h3 class="account-deletion-title">${escapeHtml(t('settings.account.deletion.heading'))}</h3>
        <p class="account-deletion-desc">${escapeHtml(t('settings.account.deletion.desc'))}</p>
        <button type="button" class="delete-account-btn" data-delete-account>${escapeHtml(t('settings.account.deletion.heading'))}</button>
      </section>
    `;
  }

  private syncDeletionConfirmEnabled(): void {
    const overlay = this.deletionDialog;
    if (!overlay) return;
    const input = overlay.querySelector<HTMLInputElement>('[data-deletion-phrase]');
    const confirm = overlay.querySelector<HTMLButtonElement>('[data-deletion-confirm]');
    if (!input || !confirm) return;
    confirm.disabled = this.deletionBusy || input.value.trim() !== DELETION_PHRASE;
    input.disabled = this.deletionBusy;
    const error = overlay.querySelector('[data-deletion-error]');
    if (error) error.textContent = this.deletionError;
  }

  private openDeletionDialog(): void {
    if (this.deletionDialog || this.deletionBusy) return;
    this.deletionError = '';
    const overlay = document.createElement('div');
    this.deletionDialog = overlay;
    overlay.className = 'account-deletion-dialog-overlay active';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    declareOverlay(overlay, { reload: 'blocking' });
    overlay.setAttribute('aria-labelledby', 'account-deletion-dialog-title');
    setTrustedHtml(
      overlay,
      trustedHtml(
        `
      <div class="account-deletion-dialog">
        <h2 id="account-deletion-dialog-title" class="account-deletion-dialog-title">${escapeHtml(t('settings.account.deletion.dialogTitle'))}</h2>
        <p class="account-deletion-dialog-copy">${escapeHtml(t('settings.account.deletion.dialogCopy'))}</p>
        <label class="account-deletion-dialog-label" for="account-deletion-phrase">${escapeHtml(t('settings.account.deletion.phraseLabel', { phrase: DELETION_PHRASE }))}</label>
        <input id="account-deletion-phrase" class="account-deletion-dialog-input" data-deletion-phrase type="text" autocomplete="off" spellcheck="false" />
        <p class="account-deletion-dialog-error" data-deletion-error role="alert"></p>
        <div class="account-deletion-dialog-actions">
          <button type="button" class="confirm-dialog-btn" data-deletion-cancel>${escapeHtml(t('common.cancel'))}</button>
          <button type="button" class="confirm-dialog-btn confirm-dialog-confirm" data-deletion-confirm disabled>${escapeHtml(t('settings.account.deletion.heading'))}</button>
        </div>
      </div>
    `,
        'account deletion confirm dialog; escaped translations',
      ),
    );
    overlay.addEventListener('click', (event) => {
      const target = event.target as HTMLElement;
      if (target === overlay || target.closest('[data-deletion-cancel]')) {
        if (!this.deletionBusy) this.closeDeletionDialog();
        return;
      }
      if (target.closest('[data-deletion-confirm]')) {
        void this.confirmAccountDeletion();
      }
    });
    const input = overlay.querySelector<HTMLInputElement>('[data-deletion-phrase]');
    this.deletionPhraseHandler = () => this.syncDeletionConfirmEnabled();
    input?.addEventListener('input', this.deletionPhraseHandler);
    document.body.appendChild(overlay);
    this.syncDeletionConfirmEnabled();
    // aria-modal is a promise to the keyboard: without a trap, Tab walks out
    // of a destructive-action dialog into the settings modal behind it, which
    // is still interactive. Escape stays with escapeHandler (no onEscape here)
    // so an in-flight deletion still cannot be dismissed.
    this.deletionFocusTrap = createFocusTrap(overlay, { initialFocus: () => input });
    this.deletionFocusTrap.activate();
  }

  private closeDeletionDialog(): void {
    const overlay = this.deletionDialog;
    if (!overlay) return;
    const input = overlay.querySelector<HTMLInputElement>('[data-deletion-phrase]');
    if (input && this.deletionPhraseHandler) {
      input.removeEventListener('input', this.deletionPhraseHandler);
    }
    this.deletionPhraseHandler = null;
    // Deactivate before the node leaves the document so the trap can hand
    // focus back to the [data-delete-account] button that opened it.
    this.deletionFocusTrap?.deactivate();
    this.deletionFocusTrap = null;
    overlay.remove();
    this.deletionDialog = null;
    this.deletionBusy = false;
    this.deletionError = '';
  }

  private async confirmAccountDeletion(): Promise<void> {
    const overlay = this.deletionDialog;
    const input = overlay?.querySelector<HTMLInputElement>('[data-deletion-phrase]');
    if (!overlay || !input || input.value.trim() !== DELETION_PHRASE || this.deletionBusy) return;
    this.deletionBusy = true;
    this.deletionError = '';
    this.syncDeletionConfirmEnabled();
    try {
      await requestOwnAccountDeletion();
      this.closeDeletionDialog();
      // Tear down directly rather than via close(): the account is gone, so an
      // unsaved draft in another panel has nothing to be saved to, and close()
      // would stop to ask "discard changes?" for it while signOut() proceeds.
      this.teardownSettings('control');
      await signOut();
      showToast(t('settings.account.deletion.deleted'));
    } catch (err) {
      const message = err instanceof Error ? err.message : t('settings.account.deletion.failed');
      if (message.includes('Account changed')) {
        // Only speak if this attempt still owns the dialog. When the account
        // switch already tore it down, the user has moved on and a late
        // "Account changed... Try again." is about a request they no longer
        // remember starting.
        const stillOurs = this.deletionDialog === overlay;
        this.closeDeletionDialog();
        if (stillOurs) showToast(message);
        return;
      }
      // The dialog is the only place the error text renders, and an account
      // switch can tear it down mid-await. Without this fallback the failure
      // is written into a detached overlay and the user is told nothing.
      if (!this.deletionDialog) {
        showToast(message);
        return;
      }
      // The server is still working when the poll gives up — its external
      // retry ladder outlasts the client timeout by design. Clearing the
      // phrase leaves Confirm disabled so the reflex second submission is not
      // one click away, while still releasing the busy latch so the dialog can
      // be dismissed; re-submitting takes a deliberate re-type.
      if (message.includes('still running')) {
        this.deletionBusy = false;
        this.deletionError = message;
        const phrase = this.deletionDialog
          ?.querySelector<HTMLInputElement>('[data-deletion-phrase]');
        if (phrase) phrase.value = '';
        this.syncDeletionConfirmEnabled();
        return;
      }
      this.deletionBusy = false;
      this.deletionError = message;
      this.syncDeletionConfirmEnabled();
    }
  }

  private categoryMatchesVariant(catDef: { variants?: string[] }): boolean {
    return !catDef.variants || catDef.variants.includes(SITE_VARIANT);
  }

  private getAvailablePanelCategories(): Array<{ key: string; label: string }> {
    return [
      { key: 'all', label: t('header.sourceRegionAll') },
      ...getVariantPanelCategories(this.config.getPanelSettings(), SITE_VARIANT)
        .map(({ key, labelKey }) => ({ key, label: t(labelKey) })),
    ];
  }

  /** Every panel the Panels page can list, before the category and filter narrow it. */
  private listedPanelEntries(): Array<[string, PanelConfig]> {
    return Object.entries(this.draftPanelSettings)
      .filter(([key]) => (key !== 'runtime-config' || this.config.isDesktopApp) && !key.startsWith('cw-'));
  }

  private getVisiblePanelEntries(): Array<[string, PanelConfig]> {
    let entries = this.listedPanelEntries();

    if (this.activePanelCategory !== 'all') {
      const catDef = PANEL_CATEGORY_MAP[this.activePanelCategory];
      if (catDef) {
        if (!this.categoryMatchesVariant(catDef)) {
          return [];
        }
        const allowed = new Set(catDef.panelKeys);
        entries = entries.filter(([key]) => allowed.has(key));
      }
    }

    if (this.panelFilter) {
      const lower = this.panelFilter.toLowerCase();
      entries = entries.filter(([key, panel]) =>
        key.toLowerCase().includes(lower) ||
        panel.name.toLowerCase().includes(lower) ||
        this.config.getLocalizedPanelName(key, panel.name).toLowerCase().includes(lower)
      );
    }

    return entries;
  }

  private renderPanelCategoryPills(): void {
    const bar = this.overlay.querySelector('#usPanelCatBar');
    if (!bar) return;

    const categories = this.getAvailablePanelCategories();
    setTrustedHtml(bar, trustedHtml(categories.map(c =>
      `<button class="unified-settings-region-pill${this.activePanelCategory === c.key ? ' active' : ''}" data-panel-cat="${c.key}">${escapeHtml(c.label)}</button>`
    ).join(''), "legacy direct innerHTML migration"));
  }

  private renderPanelsTab(): void {
    const container = this.overlay.querySelector('#usPanelToggles');
    if (!container) return;

    const savedSettings = this.config.getPanelSettings();
    const entries = this.getVisiblePanelEntries();
    const panelFontScaleLabel = t('preferences.panelFontScale', { defaultValue: 'Text size' });
    const followGlobalFontScaleLabel = t('preferences.followGlobalFontScale', { defaultValue: 'Use global' });
    setTrustedHtml(container, trustedHtml(entries.map(([key, panel]) => {
      // Preserve saved config for dynamic cw-* panels; unknown keys should not
      // collapse to getEffectivePanelConfig's disabled synthetic fallback.
      const resolvedPanel = ALL_PANELS[key] ? getEffectivePanelConfig(key, SITE_VARIANT) : panel;
      const changed = this.isPanelDraftChanged(key, panel, savedSettings);
      const displayName = this.config.getLocalizedPanelName(key, resolvedPanel.name ?? panel.name);
      const a11yState = getPanelToggleA11yState(false, panel.enabled, displayName);
      // Sandboxed MCP iframes cannot inherit the host panel's CSS scale.
      const supportsPanelFontScale = key !== 'map' && !key.startsWith('mcp-');
      const on = panel.enabled;
      return `
        <div class="panel-settings-item${supportsPanelFontScale ? ' has-font-scale' : ''}">
          <button type="button" class="panel-toggle-item ${on ? 'active' : ''}${changed ? ' changed' : ''}" data-panel="${escapeHtml(key)}" ${a11yState.ariaPressed === null ? '' : `aria-pressed="${a11yState.ariaPressed}"`} ${a11yState.ariaLabel === null ? '' : `aria-label="${escapeHtml(a11yState.ariaLabel)}"`}>
            <span class="panel-toggle-label">${escapeHtml(displayName)}</span>
            <span class="panel-toggle-switch" aria-hidden="true"></span>
          </button>
          ${supportsPanelFontScale ? `<label class="panel-font-scale-control">
            <span class="panel-font-scale-value" data-panel-scale-summary aria-hidden="true">${escapeHtml(panelFontScaleSummary(panel.fontScale))}</span>
            <select data-panel-font-scale="${escapeHtml(key)}" aria-label="${escapeHtml(`${displayName}: ${panelFontScaleLabel}`)}">
              <option value="global"${panel.fontScale === undefined ? ' selected' : ''}>${escapeHtml(followGlobalFontScaleLabel)}</option>
              ${FONT_SCALE_STEPS.map(scale => `<option value="${scale}"${panel.fontScale === scale ? ' selected' : ''}>${fontScaleLabel(scale)}</option>`).join('')}
            </select>
          </label>` : ''}
        </div>
      `;
    }).join(''), "legacy direct innerHTML migration"));

    this.updatePanelsFooter();
  }

  private clonePanelSettings(source: Record<string, PanelConfig> = this.config.getPanelSettings()): Record<string, PanelConfig> {
    const cloned: Record<string, PanelConfig> = Object.fromEntries(
      Object.entries(source).map(([key, panel]) => [key, { ...panel }]),
    );
    for (const key of Object.keys(ALL_PANELS)) {
      if (!(key in cloned)) {
        cloned[key] = { ...getEffectivePanelConfig(key, SITE_VARIANT), enabled: isPanelInVariantDefaults(key) };
      }
    }
    return cloned;
  }

  private resetPanelDraft(): void {
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = false;
  }

  private getSavedPanelEnabled(key: string, savedSettings: Record<string, PanelConfig>): boolean {
    const savedPanel = savedSettings[key];
    if (savedPanel) return savedPanel.enabled;
    return Boolean(ALL_PANELS[key]) && isPanelInVariantDefaults(key);
  }

  private getSavedPanelFontScale(
    key: string,
    savedSettings: Record<string, PanelConfig>,
  ): PanelConfig['fontScale'] {
    return savedSettings[key]?.fontScale;
  }

  private isPanelDraftChanged(
    key: string,
    panel: PanelConfig,
    savedSettings: Record<string, PanelConfig>,
  ): boolean {
    return this.getSavedPanelEnabled(key, savedSettings) !== panel.enabled
      || this.getSavedPanelFontScale(key, savedSettings) !== panel.fontScale;
  }

  private hasPendingPanelChanges(): boolean {
    const savedSettings = this.config.getPanelSettings();
    return Object.entries(this.draftPanelSettings).some(
      ([key, panel]) => this.isPanelDraftChanged(key, panel, savedSettings),
    );
  }

  private toggleDraftPanel(key: string): void {
    const panel = this.draftPanelSettings[key];
    if (!panel) return;
    panel.enabled = !panel.enabled;
    this.panelsJustSaved = false;
    this.renderPanelsTab();
  }

  private savePanelChanges(): void {
    if (!this.hasPendingPanelChanges()) return;
    this.config.savePanelSettings(Object.fromEntries(Object.entries(this.draftPanelSettings).map(([k, v]) => [k, { ...v }])));
    this.draftPanelSettings = this.clonePanelSettings();
    this.panelsJustSaved = true;
    this.renderPanelsTab();
    if (this.savedTimeout) clearTimeout(this.savedTimeout);
    this.savedTimeout = setTimeout(() => {
      this.panelsJustSaved = false;
      this.savedTimeout = null;
      this.updatePanelsFooter();
    }, 2000);
  }

  private updatePanelsFooter(): void {
    const status = this.overlay.querySelector<HTMLElement>('#usPanelsStatus');
    const saveButton = this.overlay.querySelector<HTMLButtonElement>('.panels-save-layout');
    const hasPendingChanges = this.hasPendingPanelChanges();

    if (saveButton) {
      saveButton.disabled = !hasPendingChanges;
    }

    if (status) {
      status.textContent = this.panelsJustSaved ? t('modals.settingsWindow.saved') : '';
      status.classList.toggle('visible', this.panelsJustSaved);
    }
  }

  private getAvailableRegions(): Array<{ key: string; label: string }> {
    // A region pill shows when at least one of its sources is actually being
    // loaded — getAllSourceNames() covers the active preset PLUS any cross-
    // variant panels the user enabled, so customized-in regions appear too.
    const allowed = new Set(this.config.getAllSourceNames());
    const regions: Array<{ key: string; label: string }> = [
      { key: 'all', label: t('header.sourceRegionAll') }
    ];

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      if (regionKey === 'intel') {
        if (INTEL_SOURCES.length > 0) {
          regions.push({ key: regionKey, label: t(regionDef.labelKey) });
        }
        continue;
      }
      const hasFeeds = regionDef.feedKeys.some(fk =>
        (CANONICAL_FEEDS[fk] ?? []).some(f => allowed.has(f.name)));
      if (hasFeeds) {
        regions.push({ key: regionKey, label: t(regionDef.labelKey) });
      }
    }

    return regions;
  }

  private getSourcesByRegion(): Map<string, string[]> {
    const map = new Map<string, string[]>();
    // Resolve region membership from CANONICAL_FEEDS (the all-variant union),
    // then intersect with the sources actually loaded — getAllSourceNames()
    // already covers the active preset + any custom panels the user enabled —
    // so a customized-in panel's sources show under their proper region pill,
    // not just the 'all' view.
    const allowed = new Set(this.config.getAllSourceNames());

    for (const [regionKey, regionDef] of Object.entries(SOURCE_REGION_MAP)) {
      const sources: string[] = [];
      if (regionKey === 'intel') {
        INTEL_SOURCES.forEach(f => sources.push(f.name));
      } else {
        for (const fk of regionDef.feedKeys) {
          for (const f of CANONICAL_FEEDS[fk] ?? []) {
            if (allowed.has(f.name)) sources.push(f.name);
          }
        }
      }
      if (sources.length > 0) {
        map.set(regionKey, sources.sort((a, b) => a.localeCompare(b)));
      }
    }

    return map;
  }

  private getVisibleSourceNames(): string[] {
    let sources: string[];
    if (this.activeSourceRegion === 'all') {
      sources = this.config.getAllSourceNames();
    } else {
      const byRegion = this.getSourcesByRegion();
      sources = byRegion.get(this.activeSourceRegion) || [];
    }

    if (this.sourceFilter) {
      const lower = this.sourceFilter.toLowerCase();
      sources = sources.filter(s => s.toLowerCase().includes(lower));
    }

    return sources;
  }

  private renderRegionPills(): void {
    const bar = this.overlay.querySelector('#usRegionBar');
    if (!bar) return;

    const regions = this.getAvailableRegions();
    setTrustedHtml(bar, trustedHtml(regions.map(r =>
      `<button class="unified-settings-region-pill${this.activeSourceRegion === r.key ? ' active' : ''}" data-region="${r.key}">${escapeHtml(r.label)}</button>`
    ).join(''), "legacy direct innerHTML migration"));
  }

  private renderSourcesGrid(): void {
    const container = this.overlay.querySelector('#usSourceToggles');
    if (!container) return;

    const sources = this.getVisibleSourceNames();
    const disabled = this.config.getDisabledSources();

    setTrustedHtml(container, trustedHtml(sources.map(source => {
      const isEnabled = !disabled.has(source);
      const escaped = escapeHtml(source);
      return `
        <button type="button" class="source-toggle-item ${isEnabled ? 'active' : ''}" aria-pressed="${isEnabled}" data-source="${escaped}">
          <div class="source-toggle-checkbox" aria-hidden="true">${isEnabled ? '\u2713' : ''}</div>
          <span class="source-toggle-label">${escaped}</span>
        </button>
      `;
    }).join(''), "legacy direct innerHTML migration"));
  }

  private updateSourcesCounter(): void {
    const counter = this.overlay.querySelector('#usSourcesCounter');
    if (!counter) return;

    const disabled = this.config.getDisabledSources();
    const allSources = this.config.getAllSourceNames();
    const enabledTotal = allSources.length - disabled.size;

    counter.textContent = t('header.sourcesEnabled', { enabled: String(enabledTotal), total: String(allSources.length) });
  }

  /**
   * Presets with at least one source that resolves in the runtime-known
   * source set. Narrow variants (or disabled news panels) can leave a preset
   * with nothing to enable — those chips are dead, so don't offer them.
   */
  private getApplicableTheaterPresets(): readonly TheaterPreset[] {
    const known = new Set(this.config.getAllSourceNames());
    return THEATER_PRESETS.filter((preset) => resolveTheaterPresetSources(preset, known).length > 0);
  }

  /**
   * Theater coverage preset (#5956): additively enable the preset's sources.
   * Uses the same bulk primitive as select-all, so persistence, the free
   * source cap, and cloud sync behave identically; unrelated sources are
   * never touched.
   */
  private applyCoveragePreset(presetId: string): void {
    const preset = getTheaterPreset(presetId);
    if (!preset) return;

    const known = new Set(this.config.getAllSourceNames());
    const resolvable = resolveTheaterPresetSources(preset, known);
    const toEnable = getTheaterPresetEnableList(preset, this.config.getDisabledSources(), known);
    const label = t(preset.labelKey);

    // Zero resolvable sources (narrow variant or unloaded panels) is not the
    // same as "already applied" — say so. Normally unreachable because the
    // chips row only renders applicable presets; kept as a defensive guard.
    if (resolvable.length === 0) {
      showToast(t('theaterPresets.unavailable', { preset: label }));
      return;
    }

    if (toEnable.length === 0) {
      showToast(t('theaterPresets.alreadyApplied', { preset: label }));
      return;
    }

    // setSourcesEnabled no-ops (with its own free-cap toast) when the free
    // source cap would be exceeded — only re-render and claim success when
    // state actually changed.
    const disabledSizeBefore = this.config.getDisabledSources().size;
    this.config.setSourcesEnabled(toEnable, true);
    if (this.config.getDisabledSources().size !== disabledSizeBefore) {
      this.renderSourcesGrid();
      this.updateSourcesCounter();
      showToast(t('theaterPresets.applied', { preset: label, count: String(toEnable.length) }));
    }
  }
}
