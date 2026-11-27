import type { Monitor, PanelConfig, MapLayers } from '@/types';
import {
  isStockResearchPath,
  stockResearchSymbolFromPath,
} from '@/features/stock-research/stock-research-route';
import { openStockResearchOverlay } from '@/features/stock-research/stock-research-overlay';
import type { AppContext } from '@/app/app-context';
import type { LoadAllDataTrigger } from '@/app/viewport-hydration-ledger';
import {
  REFRESH_INTERVALS,
  DEFAULT_PANELS,
  DEFAULT_MAP_LAYERS,
  MOBILE_DEFAULT_MAP_LAYERS,
  STORAGE_KEYS,
  SITE_VARIANT,
  ALL_PANELS,
  VARIANT_DEFAULTS,
  getEffectivePanelConfig,
  getInitialPanelSettingsForVariant,
  restoreProGatedPanels,
  isRetiredPanel,
  RETIRED_PANEL_IDS,
} from '@/config';
import {
  sanitizeLayersForVariant,
  restoreGateOwnedLockedLayers,
  mapLayerStatesEqual,
} from '@/config/map-layer-definitions';
import type { MapVariant } from '@/config/map-layer-definitions';
import {
  openStorageForBoot,
  cleanOldSnapshots,
  isAisConfigured,
  initAisStream,
  isOutagesConfigured,
  disconnectAisStream,
  startFlightHistoryCleanup,
  stopFlightHistoryCleanup,
} from '@/services';
import { enableVesselRuntime, stopLoadedVesselHistoryCleanup } from '@/services/military-vessels-lazy';
import { mlWorker } from '@/services/ml-worker';
import { getAiFlowSettings, subscribeAiFlowChange, isHeadlineMemoryEnabled } from '@/services/ai-flow-settings';
import { startLearning } from '@/services/country-instability';
import {
  isMobileDevice,
  isQuotaError,
  loadFromStorage,
  markStorageQuotaExceeded,
  parseMapUrlState,
  readDashboardSearchQuery,
  saveToStorage,
  showToast,
} from '@/utils';
import { clearPanelSpans, clearPanelSpanEntry, clearPanelColSpanEntry, loadPanelCollapsed, savePanelCollapsed } from '@/utils/panel-storage';
import type { OrbitalShareLink } from '@/utils/urlState';
import { scheduleOrbitalShareLink, takeOrbitalShareLink } from '@/app/orbital-share-link';
import { connectOrbitalLookupMap } from '@/services/orbital/lookup-host';
import { ORBITAL_WATCH_ENABLED } from '@/config/orbital-watch-flag';
import { overlayHistory, type OverlayId } from '@/utils/overlay-history';
import type { ParsedMapUrlState } from '@/utils';
import { BreakingNewsBanner } from '@/components/BreakingNewsBanner';
import { initBreakingNewsAlerts, destroyBreakingNewsAlerts } from '@/services/breaking-news-alerts';
import { markLcpDebug } from '@/utils/lcp-debug';
import { safeStorageGet, safeStorageSet } from '@/utils/safe-storage';
import type { ServiceStatusPanel } from '@/components/ServiceStatusPanel';
import type { EnergyCrisisPanel } from '@/components/EnergyCrisisPanel';
import type { MacroSignalsPanel } from '@/components/MacroSignalsPanel';
import type { FearGreedPanel } from '@/components/FearGreedPanel';
import type { HormuzPanel } from '@/components/HormuzPanel';
import type { StrategicPosturePanel } from '@/components/StrategicPosturePanel';
import type { StrategicRiskPanel } from '@/components/StrategicRiskPanel';
import type { GulfEconomiesPanel } from '@/components/GulfEconomiesPanel';
import type { GroceryBasketPanel } from '@/components/GroceryBasketPanel';
import type { FuelPricesPanel } from '@/components/FuelPricesPanel';
import type { FxPanel } from '@/components/FxPanel';
import type { FaoFoodPriceIndexPanel } from '@/components/FaoFoodPriceIndexPanel';
import type { OilInventoriesPanel } from '@/components/OilInventoriesPanel';
import type { PipelineStatusPanel } from '@/components/PipelineStatusPanel';
import type { StorageFacilityMapPanel } from '@/components/StorageFacilityMapPanel';
import type { FuelShortagePanel } from '@/components/FuelShortagePanel';
import type { EnergyDisruptionsPanel } from '@/components/EnergyDisruptionsPanel';
import type { EnergyRiskOverviewPanel } from '@/components/EnergyRiskOverviewPanel';
import type { GridDisruptionClockPanel } from '@/components/GridDisruptionClockPanel';
import type { ChokepointStripPanel } from '@/components/ChokepointStripPanel';
import type { ClimateNewsPanel } from '@/components/ClimateNewsPanel';
import type { ConsumerPricesPanel } from '@/components/ConsumerPricesPanel';
import type { MacroTilesPanel } from '@/components/MacroTilesPanel';
import type { FSIPanel } from '@/components/FSIPanel';
import type { YieldCurvePanel } from '@/components/YieldCurvePanel';
import type { EconomicCalendarPanel } from '@/components/EconomicCalendarPanel';
import type { CotPositioningPanel } from '@/components/CotPositioningPanel';
import type { LiquidityShiftsPanel } from '@/components/LiquidityShiftsPanel';
import type { NewsMarketCorrelationPanel } from '@/components/NewsMarketCorrelationPanel';
import type { PositioningPanel } from '@/components/PositioningPanel';
import type { GoldIntelligencePanel } from '@/components/GoldIntelligencePanel';
import { BETA_MODE } from '@/config/beta';
import { preloadCountryGeometry, isCountryGeometryLoaded, getCountryNameByCode } from '@/services/country-geometry';
import { initI18n, t, I18N_RESOURCES_LOADED_EVENT, type I18nResourcesLoadedDetail } from '@/services/i18n';
import { initDeferredDashboardFonts } from '@/bootstrap/secondary-startup';

import {
  CANADA_ARCTIC_OPT_IN_SOURCES,
  CANADA_DEPTH_OPT_IN_SOURCES,
  CRISIS_FLOOR_OPT_IN_SOURCES,
  CURATED_REGIONAL_OPT_IN_SOURCES,
  GERMAN_RSS_SOURCES,
  computeDefaultDisabledSources,
  computeLegacyDefaultDisabledSources,
  FEEDS,
  FREE_CAP_PROTECTED_SOURCES,
  FRONTLINE_EUROPE_PROTECTED_SOURCES,
  getLocaleBoostedSources,
  getStrategicDefaultSources,
  getTotalFeedCount,
  INTEL_SOURCES,
} from '@/config/feeds';
import {
  computeCapDisabledSources,
  findFullyDisabledCategories,
  inferExactSourceGateOwnership,
  restoreGateOwnedSources,
  selectSourcesUnderCap,
  stringSetsEqual,
} from '@/services/source-cap';
import {
  applyVariantPanelLayoutTransition,
  persistGateOwnershipTransition,
  resolveAppliedPanelLayoutVariant,
} from '@/services/variant-panel-ownership';
import {
  buildPreStrategicDefaultDisabledStates,
  buildRegionalFeedRolloutMigrationTargets,
} from '@/services/regional-feed-rollout';
import {
  cancelBootstrapSlowTier,
  fetchBootstrapData,
  getBootstrapHydrationState,
  markBootstrapAsLive,
  waitForBootstrapSlowTier,
  type BootstrapHydrationState,
} from '@/services/bootstrap';
import { describeFreshness } from '@/services/persistent-cache';
import { CountryIntelManager } from '@/app/country-intel';
import {
  DashboardBindingError,
  isWebMcpAbortError,
  raceWebMcpAbort,
  throwIfWebMcpAborted,
  type WebMcpAppBindings,
  type WebMcpExecutionOptions,
} from '@/services/webmcp';
import {
  applyWebMcpMissionPreset,
  applyWebMcpOpenAlerts,
  applyWebMcpOpenMissionPicker,
  applyWebMcpOpenSettings,
  applyWebMcpSwitchMonitor,
  getWebMcpDashboardContext,
  getWebMcpMapLayerCatalogSnapshot,
  listWebMcpDashboardPanels,
  listWebMcpMissionPresets,
  WEBMCP_UI_READY_TIMEOUT_MS,
  waitForWebMcpUiReady,
} from '@/app/webmcp-dashboard';
import type { MapLayerRuntimeAvailability } from '@/services/map-layer-runtime-availability';
import { buildWebMcpAccessContext } from '@/services/webmcp-access-snapshot';
import { runDashboardActionBinding } from '@/app/dashboard-action-binding';
import { selectWebMcpPanelTab } from '@/app/webmcp-panel-tab-binding';
import { refreshDataFreshnessFromHealth } from '@/services/health-freshness';
import { scheduleAfterFirstPaint } from '@/utils/after-paint';
import type { SearchManager } from '@/app/search-manager';
import { RefreshScheduler } from '@/app/refresh-scheduler';
import { PanelLayoutManager } from '@/app/panel-layout';
import { DataLoaderManager } from '@/app/data-loader';
import { EventHandlerManager } from '@/app/event-handlers';
import { isCatalogPanelLive, waitUntilPanelLive } from '@/app/panel-enablement';
import { replaceRawI18nKeyPlaceholders } from '@/utils/i18n-raw-key-healer';
import { initialRegionFromCache, resolveUserRegion, resolvePreciseUserCoordinates, type PreciseCoordinates } from '@/utils/user-location';
import {
  migrateFrontlineEuropeDefaultsV3,
  migrateStrategicDefaultsV4,
  migrateRegionalFeedRolloutDefaultsV5,
  migrateCanadaArcticOptInsV6,
  migrateCanadaDepthOptInsV7,
  migrateCrisisDeskOptInsV8,
  migrateCuratedRegionalOptInsV9,
  migrateGermanRssSourcesV10,
} from '@/utils/cloud-prefs-migrations';
import {
  addCountry,
  getFollowed,
  installFollowedCountriesListeners,
  isFollowFeatureEnabled,
  isFollowed,
  removeCountry,
  serviceEntitlementState,
} from '@/services/followed-countries';
import { nextPrimeRetryDelayMs } from '@/utils/prime-retry';

/** Look-ahead margin for viewport-gated panel priming and refresh scheduling. */
const DEFAULT_VIEWPORT_MARGIN_PX = 400;
// CorrelationEngine + its 4 adapters are dynamic-imported at the post-loadAllData
// run site (#4486) so the engine bytes stay off the eager boot graph. The TYPE is
// referenced via the inline `import(...)` type in app-context.ts (erased at build).
import type { CorrelationPanel } from '@/components/CorrelationPanel';
import { CORRELATION_DOMAINS } from '@/types/correlation';

const CYBER_LAYER_ENABLED = import.meta.env.VITE_ENABLE_CYBER_LAYER === 'true';
// The retired free-tier source cap. Profiles it trimmed before ownership
// metadata existed are healed by recomputing what the cap auto-disabled.
const LEGACY_FREE_MAX_SOURCES = 80;
const WORLD_NEWS_REFRESH_MS = 5 * 60_000;
type SignalModalInstance = import('@/components/SignalModal').SignalModal;

export type { CountryBriefSignals } from '@/app/app-context';

export class App {
  private state: AppContext;
  private pendingDeepLinkCountry: string | null = null;
  private pendingDeepLinkExpanded = false;
  private pendingDeepLinkStoryCode: string | null = null;
  private pendingDeepLinkChokepoint: string | null = null;
  private pendingDeepLinkSearchQuery: string | null = null;
  private pendingOrbitalShareLink: OrbitalShareLink | null = null;
  private cancelOrbitalShareLink: (() => void) | null = null;
  private chokepointDeepLinkTimer: number | null = null;
  /** World first screen news refresh; cleared when the full view starts. */
  private worldNewsTimer: number | null = null;
  private stockDeepLinkTimer: number | null = null;
  // At most one automatic precise mobile recenter per startup (#7778). Set
  // when the late position callback fires; cleared on destroy/re-init so a new
  // App instance gets its own single attempt.
  private autoGeoRecenterApplied = false;

  private panelLayout: PanelLayoutManager;
  private dataLoader: DataLoaderManager;
  private eventHandlers: EventHandlerManager;
  private searchManager: SearchManager | null = null;
  private searchManagerLoad: Promise<SearchManager> | null = null;
  private signalModalLoad: Promise<SignalModalInstance> | null = null;
  // Monotonic epoch: every openSearch() call supersedes earlier in-flight ones.
  // searchToggleDesiredOpen accumulates the net intent of rapid Cmd+K presses
  // while the lazy chunk loads (XOR: odd → open, even → cancel). (#4403 review)
  private openSearchEpoch = 0;
  private searchToggleDesiredOpen = false;
  private latestSearchAdsb: Parameters<SearchManager['updateFlightSource']>[0] = [];
  private latestSearchMilitary: Parameters<SearchManager['updateFlightSource']>[1] = [];
  private latestSearchAdsbUpdatedAt = 0;
  private countryIntel: CountryIntelManager;
  private refreshScheduler: RefreshScheduler;

  private modules: { destroy(): void }[] = [];
  private unsubAiFlow: (() => void) | null = null;
  /**
   * Boot epoch for optional local-AI continuations (#7779). destroy() bumps
   * it first so a stale detached continuation from a torn-down App can never
   * download a model or restart the shared worker a fresh same-document App
   * reuses. Continuations also check state.isDestroyed directly.
   */
  private localAiInitEpoch = 0;
  // Resolves once Phase-4 UI modules have initialised so WebMCP bindings can
  // await readiness before dispatching into UI managers. Avoids the startup
  // race where an agent discovers a tool via early registerTool and invokes it
  // before the manager that owns its target is ready.
  private uiReady!: Promise<void>;
  private resolveUiReady!: () => void;
  private appDestroyed!: Promise<void>;
  private resolveAppDestroyed!: () => void;
  // Returned by registerWebMcpTools in browser runtimes — aborting it removes
  // late-provider listeners and unregisters every accepted tool. destroy()
  // triggers it so test harnesses / same-document re-inits don't accumulate
  // duplicate registrations.
  private webMcpController: AbortController | null = null;
  // Cancels App-owned waits that have already entered a callback. Distinct from
  // the tool-invocation caller signal, and from webMcpController which only
  // unregisters tools — aborting registration does not stop an in-flight waiter.
  private readonly lifecycleController = new AbortController();
  private visiblePanelPrimed = new Set<string>();
  /**
   * Per-pass viewport results, or null outside a pass. See
   * {@link primeViewportNearCache}.
   */
  private viewportNearCache: Map<string, boolean> | null = null;
  /** Consecutive prime failures per key, for the retry backoff. */
  private visiblePanelPrimeFailures = new Map<string, number>();
  /** Earliest `Date.now()` at which a failed prime key may be retried. */
  private visiblePanelPrimeRetryAt = new Map<string, number>();
  private visiblePanelPrimeRaf: number | null = null;
  private visiblePanelPrimeFullPass = false;
  private viewportHydrationReady = false;
  private viewportHydrationReadyAt = 0;
  private slowTierWaitTimedOut = false;
  /** Scroll/resize register at readiness; marks/primes arm only after fan-out. */
  private viewportTriggersArmed = false;
  private bootstrapHydrationState: BootstrapHydrationState = getBootstrapHydrationState();
  private cachedModeBannerEl: HTMLElement | null = null;
  private readonly handleViewportPrime = (event?: Event): void => {
    if (!this.viewportHydrationReady || this.state.isDestroyed) return;
    // The catch-up scan after fan-out covers early viewport changes without
    // replaying their scroll events as viewport-trigger marks. (#5876)
    if (!this.viewportTriggersArmed) return;
    if (
      event &&
      this.viewportHydrationReadyAt > 0 &&
      event.timeStamp < this.viewportHydrationReadyAt
    ) {
      return;
    }
    if (
      event?.type === 'scroll' &&
      event.target instanceof Element &&
      !event.target.matches('.main-content, .panels-grid')
    ) {
      return;
    }
    // A resize can move panels across layout breakpoints, so it keeps a full
    // pass. A scroll only needs data for panels entering range for the first
    // time; re-running loaded panels re-fetched their data on every frame.
    if (event?.type === 'resize') this.visiblePanelPrimeFullPass = true;
    if (this.visiblePanelPrimeRaf !== null) return;
    this.visiblePanelPrimeRaf = window.requestAnimationFrame(() => {
      this.visiblePanelPrimeRaf = null;
      const trigger: LoadAllDataTrigger = this.visiblePanelPrimeFullPass ? 'full' : 'viewport';
      this.visiblePanelPrimeFullPass = false;
      markLcpDebug('wm:hydration:viewport-trigger');
      void this.primeVisiblePanelData();
      // loadAllData covers panels primeVisiblePanelData does not (news,
      // markets, intelligence, fred, …). Now that bootstrap runs with
      // forceAll=false, below-fold panels need this re-trigger on scroll
      // so their data lands when they enter the viewport.
      void this.dataLoader.loadAllData(false, trigger);
    });
  };
  private readonly handleConnectivityChange = (): void => {
    this.updateConnectivityUi();
  };
  private readonly handleI18nResourcesLoaded = (ev: Event): void => {
    const language = (ev as CustomEvent<I18nResourcesLoadedDetail>).detail?.language;
    if (language !== 'en') return;
    // Scope this to the app container: body-level modals are user-opened after
    // startup, by which point the full English bundle should already be loaded.
    replaceRawI18nKeyPlaceholders(this.state.container, t);
  };
  private readonly getMapLayerRuntimeAvailability = (): MapLayerRuntimeAvailability => ({
    cyberLayerEnabled: CYBER_LAYER_ENABLED,
    aisConfigured: isAisConfigured(),
    outagesAvailable: isOutagesConfigured() !== false,
  });
  private isPanelNearViewport(panelId: string, marginPx = DEFAULT_VIEWPORT_MARGIN_PX): boolean {
    if (marginPx === DEFAULT_VIEWPORT_MARGIN_PX && this.viewportNearCache) {
      const cached = this.viewportNearCache.get(panelId);
      if (cached !== undefined) return cached;
    }
    const panel = this.state.panels[panelId] as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
    return panel?.isNearViewport?.(marginPx) ?? false;
  }

  /**
   * Read every mounted panel's viewport state in one uninterrupted pass (#4487).
   *
   * `Panel.isNearViewport` calls `getComputedStyle` AND `getBoundingClientRect`,
   * both of which force style/layout. `primeVisiblePanelData` gates ~48 panels,
   * and a passing gate synchronously enters the panel's loader, several of which
   * write DOM before their first await (`showLoading` / `renderPanel`). That made
   * the pass read → write → read → write, so each read re-flushed a layout the
   * previous write had just invalidated — up to 48 forced layouts in one task,
   * dispatched from a scroll handler's rAF.
   *
   * Reading everything first means one flush, then writes only. The results are
   * valid for the whole synchronous pass: nothing scrolls or resizes mid-task.
   */
  private primeViewportNearCache(): void {
    const cache = new Map<string, boolean>();
    for (const [id, panel] of Object.entries(this.state.panels)) {
      const near = panel as { isNearViewport?: (marginPx?: number) => boolean } | undefined;
      cache.set(id, near?.isNearViewport?.(DEFAULT_VIEWPORT_MARGIN_PX) ?? false);
    }
    this.viewportNearCache = cache;
  }

  private isAnyPanelNearViewport(panelIds: string[], marginPx = DEFAULT_VIEWPORT_MARGIN_PX): boolean {
    return panelIds.some((panelId) => this.isPanelNearViewport(panelId, marginPx));
  }

  private shouldRefreshIntelligence(): boolean {
    return this.isAnyPanelNearViewport(['cii', 'strategic-risk', 'strategic-posture'])
      || !!this.state.countryBriefPage?.isVisible();
  }

  private shouldRefreshFirms(): boolean {
    return this.isPanelNearViewport('satellite-fires');
  }

  private shouldRefreshCorrelation(): boolean {
    return this.isAnyPanelNearViewport(['military-correlation', 'escalation-correlation', 'economic-correlation', 'disaster-correlation']);
  }

  private getCachedBootstrapUpdatedAt(): number | null {
    const cachedTierTimestamps = Object.values(this.bootstrapHydrationState.tiers)
      .filter((tier) => tier.source === 'cached')
      .map((tier) => tier.updatedAt)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

    if (cachedTierTimestamps.length === 0) return null;
    return Math.min(...cachedTierTimestamps);
  }

  private updateConnectivityUi(): void {
    const statusIndicator = this.state.container.querySelector('.status-indicator');
    const statusLabel = statusIndicator?.querySelector('span:last-child');
    const online = typeof navigator === 'undefined' ? true : navigator.onLine !== false;
    // Only treat a complete cache fallback (no live data at all) as "cached" for UI purposes.
    // 'mixed' means live data was partially fetched — showing "Live data unavailable" would be misleading.
    const usingCachedBootstrap = this.bootstrapHydrationState.source === 'cached';
    const cachedUpdatedAt = this.getCachedBootstrapUpdatedAt();

    let statusMode: 'live' | 'cached' | 'unavailable' = 'live';
    let bannerMessage: string | null = null;

    if (!online) {
      // Offline: show banner regardless of mixed/cached (any cached data is better than nothing)
      const hasAnyCached = this.bootstrapHydrationState.source === 'cached' || this.bootstrapHydrationState.source === 'mixed';
      if (hasAnyCached) {
        statusMode = 'cached';
        const offlineCachedAt = this.bootstrapHydrationState.tiers
          ? Math.min(...Object.values(this.bootstrapHydrationState.tiers)
              .filter((tier) => tier.source === 'cached' || tier.source === 'mixed')
              .map((tier) => tier.updatedAt)
              .filter((v): v is number => typeof v === 'number' && Number.isFinite(v)))
          : NaN;
        const freshness = Number.isFinite(offlineCachedAt) ? describeFreshness(offlineCachedAt) : t('common.cached').toLowerCase();
        bannerMessage = t('connectivity.offlineCached', { freshness });
      } else {
        statusMode = 'unavailable';
        bannerMessage = t('connectivity.offlineUnavailable');
      }
    } else if (usingCachedBootstrap) {
      statusMode = 'cached';
      const freshness = cachedUpdatedAt ? describeFreshness(cachedUpdatedAt) : t('common.cached').toLowerCase();
      bannerMessage = t('connectivity.cachedFallback', { freshness });
    }

    if (statusIndicator && statusLabel) {
      statusIndicator.classList.toggle('status-indicator--cached', statusMode === 'cached');
      statusIndicator.classList.toggle('status-indicator--unavailable', statusMode === 'unavailable');
      statusLabel.textContent = statusMode === 'live'
        ? t('header.live')
        : statusMode === 'cached'
          ? t('header.cached')
          : t('header.unavailable');
    }

    if (bannerMessage) {
      if (!this.cachedModeBannerEl) {
        this.cachedModeBannerEl = document.createElement('div');
        // CSS disables pointer events on this status-only container. Keep its descendants
        // non-interactive unless the banner interaction model is updated with it.
        this.cachedModeBannerEl.className = 'cached-mode-banner';
        this.cachedModeBannerEl.setAttribute('role', 'status');
        this.cachedModeBannerEl.setAttribute('aria-live', 'polite');

        const badge = document.createElement('span');
        badge.className = 'cached-mode-banner__badge';
        const text = document.createElement('span');
        text.className = 'cached-mode-banner__text';
        this.cachedModeBannerEl.append(badge, text);

        const header = this.state.container.querySelector('.header');
        if (header?.parentElement) {
          header.insertAdjacentElement('afterend', this.cachedModeBannerEl);
        } else {
          this.state.container.prepend(this.cachedModeBannerEl);
        }
      }

      this.cachedModeBannerEl.classList.toggle('cached-mode-banner--unavailable', statusMode === 'unavailable');
      const badge = this.cachedModeBannerEl.querySelector('.cached-mode-banner__badge')!;
      const text = this.cachedModeBannerEl.querySelector('.cached-mode-banner__text')!;
      badge.textContent = statusMode === 'cached' ? t('header.cached') : t('header.unavailable');
      text.textContent = bannerMessage;
      return;
    }

    this.cachedModeBannerEl?.remove();
    this.cachedModeBannerEl = null;
  }

  private async primeVisiblePanelData(forceAll = false): Promise<void> {
    const tasks: Promise<unknown>[] = [];
    const now = Date.now();
    const primeTask = (key: string, task: () => Promise<unknown>): void => {
      if (this.visiblePanelPrimed.has(key) || this.state.inFlight.has(key)) return;
      // A failed prime is never recorded as primed, so without this a fast-failing
      // endpoint re-enters on every scroll frame forever (#4487).
      const retryAt = this.visiblePanelPrimeRetryAt.get(key);
      if (retryAt !== undefined && now < retryAt) return;
      const wrapped = (async () => {
        this.state.inFlight.add(key);
        try {
          await task();
          this.visiblePanelPrimed.add(key);
          this.visiblePanelPrimeFailures.delete(key);
          this.visiblePanelPrimeRetryAt.delete(key);
        } catch (err) {
          const failures = (this.visiblePanelPrimeFailures.get(key) ?? 0) + 1;
          this.visiblePanelPrimeFailures.set(key, failures);
          this.visiblePanelPrimeRetryAt.set(key, Date.now() + nextPrimeRetryDelayMs(failures));
          throw err;
        } finally {
          this.state.inFlight.delete(key);
        }
      })();
      tasks.push(wrapped);
    };

    const shouldPrime = (id: string): boolean => forceAll || this.isPanelNearViewport(id);
    const shouldPrimeAny = (ids: string[]): boolean => forceAll || this.isAnyPanelNearViewport(ids);

    // Every layout read for this pass happens here, before any gate can enter a
    // loader that writes DOM. `forceAll` skips the gates entirely, so it needs no
    // reads at all.
    if (!forceAll) this.primeViewportNearCache();

    if (shouldPrime('service-status')) {
      const panel = this.state.panels['service-status'] as ServiceStatusPanel | undefined;
      if (panel) primeTask('service-status', () => panel.fetchStatus());
    }
    if (shouldPrime('macro-signals')) {
      const panel = this.state.panels['macro-signals'] as MacroSignalsPanel | undefined;
      if (panel) primeTask('macro-signals', () => panel.fetchData());
    }
    if (shouldPrime('fear-greed')) {
      const panel = this.state.panels['fear-greed'] as FearGreedPanel | undefined;
      if (panel) primeTask('fear-greed', () => panel.fetchData());
    }
    if (shouldPrime('hormuz-tracker')) {
      const panel = this.state.panels['hormuz-tracker'] as HormuzPanel | undefined;
      if (panel) primeTask('hormuz-tracker', () => panel.fetchData());
    }
    if (shouldPrime('energy-crisis')) {
      const panel = this.state.panels['energy-crisis'] as EnergyCrisisPanel | undefined;
      if (panel) primeTask('energy-crisis', () => panel.fetchData());
    }
    if (shouldPrime('gulf-economies')) {
      const panel = this.state.panels['gulf-economies'] as GulfEconomiesPanel | undefined;
      if (panel) primeTask('gulf-economies', () => panel.fetchData());
    }
    if (shouldPrime('grocery-basket')) {
      const panel = this.state.panels['grocery-basket'] as GroceryBasketPanel | undefined;
      if (panel) primeTask('grocery-basket', () => panel.fetchData());
    }
    if (shouldPrime('fuel-prices')) {
      const panel = this.state.panels['fuel-prices'] as FuelPricesPanel | undefined;
      if (panel) primeTask('fuel-prices', () => panel.fetchData());
    }
    if (shouldPrime('fx')) {
      const panel = this.state.panels['fx'] as FxPanel | undefined;
      if (panel) primeTask('fx', () => panel.fetchData());
    }
    if (shouldPrime('fao-food-price-index')) {
      const panel = this.state.panels['fao-food-price-index'] as FaoFoodPriceIndexPanel | undefined;
      if (panel) primeTask('fao-food-price-index', () => panel.fetchData());
    }
    if (shouldPrime('oil-inventories')) {
      const panel = this.state.panels['oil-inventories'] as OilInventoriesPanel | undefined;
      if (panel) primeTask('oil-inventories', () => panel.fetchData());
    }
    // Energy Atlas panels — each self-fetches via bootstrap cache + RPC fallback
    // (scripts/seed-pipelines-{gas,oil}.mjs, seed-storage-facilities.mjs,
    // seed-fuel-shortages.mjs, seed-energy-disruptions.mjs). Without these
    // primeTask wires the panels sit at showLoading() forever because
    // Panel's constructor calls showLoading() but nothing else triggers
    // fetchData() on attach — App.ts's primeTask table is the sole
    // near-viewport kickoff path.
    if (shouldPrime('pipeline-status')) {
      const panel = this.state.panels['pipeline-status'] as PipelineStatusPanel | undefined;
      if (panel) primeTask('pipeline-status', () => panel.fetchData());
    }
    if (shouldPrime('storage-facility-map')) {
      const panel = this.state.panels['storage-facility-map'] as StorageFacilityMapPanel | undefined;
      if (panel) primeTask('storage-facility-map', () => panel.fetchData());
    }
    if (shouldPrime('fuel-shortages')) {
      const panel = this.state.panels['fuel-shortages'] as FuelShortagePanel | undefined;
      if (panel) primeTask('fuel-shortages', () => panel.fetchData());
    }
    if (shouldPrime('energy-disruptions')) {
      const panel = this.state.panels['energy-disruptions'] as EnergyDisruptionsPanel | undefined;
      if (panel) primeTask('energy-disruptions', () => panel.fetchData());
    }
    if (shouldPrime('energy-risk-overview')) {
      const panel = this.state.panels['energy-risk-overview'] as EnergyRiskOverviewPanel | undefined;
      if (panel) primeTask('energy-risk-overview', () => panel.fetchData());
    }
    if (shouldPrime('grid-disruption-clock')) {
      const panel = this.state.panels['grid-disruption-clock'] as GridDisruptionClockPanel | undefined;
      if (panel) primeTask('grid-disruption-clock', () => panel.fetchData());
    }
    if (shouldPrime('chokepoint-strip')) {
      // Without this primeTask entry the panel mounts via panel-layout.ts and
      // ENERGY_PANELS but its constructor only calls showLoading() — fetchData()
      // never fires, so the panel sits at "Loading..." forever. Hard-learned in
      // PR #3386; tracked as skill panel-stuck-loading-means-missing-primetask.
      const panel = this.state.panels['chokepoint-strip'] as ChokepointStripPanel | undefined;
      if (panel) primeTask('chokepoint-strip', () => panel.fetchData());
    }
    if (shouldPrime('climate-news')) {
      const panel = this.state.panels['climate-news'] as ClimateNewsPanel | undefined;
      if (panel) primeTask('climate-news', () => panel.fetchData());
    }
    if (shouldPrime('consumer-prices')) {
      const panel = this.state.panels['consumer-prices'] as ConsumerPricesPanel | undefined;
      if (panel) primeTask('consumer-prices', () => panel.fetchData());
    }
    if (shouldPrime('macro-tiles')) {
      const panel = this.state.panels['macro-tiles'] as MacroTilesPanel | undefined;
      if (panel) primeTask('macro-tiles', () => panel.fetchData());
    }
    if (shouldPrime('fsi')) {
      const panel = this.state.panels['fsi'] as FSIPanel | undefined;
      if (panel) primeTask('fsi', () => panel.fetchData());
    }
    if (shouldPrime('yield-curve')) {
      const panel = this.state.panels['yield-curve'] as YieldCurvePanel | undefined;
      if (panel) primeTask('yield-curve', () => panel.fetchData());
    }
    if (shouldPrime('economic-calendar')) {
      const panel = this.state.panels['economic-calendar'] as EconomicCalendarPanel | undefined;
      if (panel) primeTask('economic-calendar', () => panel.fetchData());
    }
    if (shouldPrime('cot-positioning')) {
      const panel = this.state.panels['cot-positioning'] as CotPositioningPanel | undefined;
      if (panel) primeTask('cot-positioning', () => panel.fetchData());
    }
    if (shouldPrime('liquidity-shifts')) {
      const panel = this.state.panels['liquidity-shifts'] as LiquidityShiftsPanel | undefined;
      if (panel) primeTask('liquidity-shifts', () => panel.fetchData());
    }
    if (shouldPrime('positioning-247')) {
      const panel = this.state.panels['positioning-247'] as PositioningPanel | undefined;
      if (panel) primeTask('positioning-247', () => panel.fetchData());
    }
    if (shouldPrime('gold-intelligence')) {
      const panel = this.state.panels['gold-intelligence'] as GoldIntelligencePanel | undefined;
      if (panel) primeTask('gold-intelligence', () => panel.fetchData());
    }
    if (shouldPrime('market-breadth')) {
      primeTask('marketBreadth', () => this.dataLoader.loadMarketBreadth());
    }
    if (shouldPrime('news-market-correlation')) {
      const panel = this.state.panels['news-market-correlation'] as NewsMarketCorrelationPanel | undefined;
      if (panel) primeTask('news-market-correlation', () => panel.fetchData());
    }
    if (shouldPrimeAny(['markets', 'heatmap', 'commodities', 'energy-complex'])) {
      primeTask('markets', () => this.dataLoader.loadMarkets());
    }
    if (shouldPrime('polymarket')) {
      primeTask('predictions', () => this.dataLoader.loadPredictions());
    }
    if (shouldPrime('economic')) {
      primeTask('fred', () => this.dataLoader.loadFredData());
      primeTask('spending', () => this.dataLoader.loadGovernmentSpending());
      primeTask('bis', () => this.dataLoader.loadBisData());
    }
    if (shouldPrime('global-procurement')) {
      primeTask('global-tenders', () => this.dataLoader.loadGlobalTenders());
    }
    if (shouldPrime('energy-complex')) {
      primeTask('oil', () => this.dataLoader.loadOilAnalytics());
    }
    // trade-policy moved into the _wmAccess block below — see fix for
    // anonymous 401 bug where loadTradePolicy fired 6 PRO-gated RPCs
    // unconditionally on every page load.
    if (shouldPrime('supply-chain')) {
      primeTask('supplyChain', () => this.dataLoader.loadSupplyChain());
    }
    if (shouldPrime('china-corridors')) {
      primeTask('chinaCorridors', () => this.dataLoader.loadChinaCorridors({ skipIfPopulated: true }));
    }
    if (shouldPrime('china-activity-nowcast')) {
      primeTask('chinaActivityNowcast', () => this.dataLoader.loadChinaActivityNowcast({ skipIfPopulated: true }));
    }
    if (shouldPrime('cross-source-signals')) {
      primeTask('crossSourceSignals', () => this.dataLoader.loadCrossSourceSignals());
    }

    if (shouldPrime('trade-policy')) {
      primeTask('tradePolicy', () => this.dataLoader.loadTradePolicy());
    }
    if (shouldPrime('daily-market-brief')) {
      primeTask('dailyMarketBrief', () => this.dataLoader.loadDailyMarketBrief());
    }
    if (shouldPrime('market-implications')) {
      primeTask('marketImplications', () => this.dataLoader.loadMarketImplications());
    }

    // Gates are done; the cached geometry must not outlive the synchronous pass
    // or a later scroll would be gated on a stale rect.
    this.viewportNearCache = null;

    if (tasks.length > 0) {
      await Promise.allSettled(tasks);
    }
  }

  constructor(containerId: string) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Container ${containerId} not found`);

    this.uiReady = new Promise<void>((resolve) => {
      this.resolveUiReady = resolve;
    });
    this.appDestroyed = new Promise<void>((resolve) => {
      this.resolveAppDestroyed = resolve;
    });

    const PANEL_ORDER_KEY = 'panel-order';
    const PANEL_SPANS_KEY = 'worldmonitor-panel-spans';
    const PANEL_ORDER_MIGRATION_KEY = 'worldmonitor-panel-order-v1.9';
    const LAYOUT_RESET_MIGRATION_KEY = 'worldmonitor-layout-reset-v2.5';

    const isMobile = isMobileDevice();
    const monitors = loadFromStorage<Monitor[]>(STORAGE_KEYS.monitors, []);

    // Use mobile-specific defaults on first load (no saved layers)
    const defaultLayers = isMobile ? MOBILE_DEFAULT_MAP_LAYERS : DEFAULT_MAP_LAYERS;

    let mapLayers: MapLayers;
    let panelSettings: Record<string, PanelConfig>;

    // Panels that must survive variant switches: user-created widgets, MCP panels.
    const isDynamicPanel = (k: string) => !ALL_PANELS[k] && (k.startsWith('cw-') || k.startsWith('mcp-'));

    const currentVariant = SITE_VARIANT;
    let appliedPanelLayoutVariant: string | null = null;
    let storageAvailable = true;
    try {
      appliedPanelLayoutVariant = resolveAppliedPanelLayoutVariant({
        appliedVariant: localStorage.getItem(STORAGE_KEYS.panelLayoutVariant),
        legacyVariant: localStorage.getItem(STORAGE_KEYS.variant),
        currentVariant,
        validVariants: new Set(Object.keys(VARIANT_DEFAULTS)),
        persistAppliedVariant: (variant) => {
          localStorage.setItem(STORAGE_KEYS.panelLayoutVariant, variant);
          return true;
        },
      });
      const probeKey = 'wm-storage-capability-probe';
      localStorage.setItem(probeKey, '1');
      localStorage.removeItem(probeKey);
    } catch {
      storageAvailable = false;
    }

    // Blocked storage is a supported no-persistence mode. Seed the same
    // defaults as a first visit and skip migrations that only mutate storage.
    if (!storageAvailable) {
      mapLayers = sanitizeLayersForVariant({ ...defaultLayers }, currentVariant as MapVariant);
      panelSettings = getInitialPanelSettingsForVariant(currentVariant);
    } else if (appliedPanelLayoutVariant !== currentVariant) {
      // Variant changed - reset all settings to variant defaults.
      console.log(`[App] Variant check: applied="${appliedPanelLayoutVariant}", current="${currentVariant}"`);
      // Variant changed — seed new variant's panels, disable panels not in the new variant
      console.log('[App] Variant changed - seeding new defaults, disabling cross-variant panels');
      // Reset map layers for the new variant (map layers are not user-personalized the same way)
      localStorage.removeItem(STORAGE_KEYS.mapLayers);
      // Write an explicit empty set rather than removing the key: cloud sync
      // now tolerates an ABSENT ownership sidecar (a row that predates it must
      // not delete local ownership), so a genuine variant-reset clear only
      // propagates cross-device when it is an explicit value.
      localStorage.setItem(STORAGE_KEYS.mapLayerGateOwnership, '[]');
      mapLayers = sanitizeLayersForVariant({ ...defaultLayers }, currentVariant as MapVariant);
      // Load existing panel prefs (if any), disable panels not belonging to the new variant
      const newVariantKeys = new Set(VARIANT_DEFAULTS[currentVariant] ?? []);
      const hadLegacyPanelLayoutState = localStorage.getItem(PANEL_ORDER_KEY) !== null
        || localStorage.getItem(PANEL_SPANS_KEY) !== null;
      panelSettings = applyVariantPanelLayoutTransition({
        currentVariant,
        panelSettings: loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {}),
        variantPanelKeys: newVariantKeys,
        isDynamicPanel,
        getDefaultPanel: (key) => getEffectivePanelConfig(key, currentVariant),
        // Use the throwing primitive here so the transition helper advances
        // the applied-layout marker only after the panel blob is durable.
        persistPanels: (next) => localStorage.setItem(STORAGE_KEYS.panels, JSON.stringify(next)),
        persistAppliedVariant: (variant) => {
          // Both markers advance HERE, inside the helper's success path, and
          // never after a failed panel write. Advancing the legacy key
          // unconditionally used to erase the retry: on the next boot
          // resolveAppliedPanelLayoutVariant would see a null applied marker
          // beside a legacy key already equal to the current variant, take its
          // SEEDING branch, and silently record the failed reset as applied.
          //
          // Order is load-bearing: the legacy key (read by bootstrap/theme and
          // by SITE_VARIANT on desktop) goes first, and the applied-layout
          // marker — the "this layout is durable" flag — goes last.
          localStorage.setItem(STORAGE_KEYS.variant, variant);
          localStorage.setItem(STORAGE_KEYS.panelLayoutVariant, variant);
        },
      });
      if (
        !hadLegacyPanelLayoutState
        && localStorage.getItem(STORAGE_KEYS.panelLayoutVariant) === currentVariant
      ) {
        try {
          localStorage.setItem(PANEL_ORDER_MIGRATION_KEY, 'done');
          localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
        } catch {
          // Blocked storage leaves the legacy migrations eligible for a later retry.
        }
      }
    } else {
      mapLayers = sanitizeLayersForVariant(
          loadFromStorage<MapLayers>(STORAGE_KEYS.mapLayers, defaultLayers),
          currentVariant as MapVariant,
        );
      // Restore layers the retired free-tier gate turned off.
      mapLayers = this.restoreGateOwnedMapLayers(mapLayers);

      panelSettings = loadFromStorage<Record<string, PanelConfig>>(
        STORAGE_KEYS.panels,
        DEFAULT_PANELS
      );

      // One-time migration: preserve user preferences across panel key renames.
      const PANEL_KEY_RENAMES_MIGRATION_KEY = 'worldmonitor-panel-key-renames-v2.6.8';
      if (!localStorage.getItem(PANEL_KEY_RENAMES_MIGRATION_KEY)) {
        let migrated = false;
        const keyRenames: Array<[string, string]> = [
          ...(SITE_VARIANT === 'finance' ? [['regulation', 'fin-regulation'] as [string, string]] : []),
        ];
        // In non-finance variants, 'regulation' was dead config (no feeds). Just prune it.
        if (SITE_VARIANT !== 'finance' && panelSettings['regulation']) {
          delete panelSettings['regulation'];
          migrated = true;
        }
        for (const [legacyKey, nextKey] of keyRenames) {
          if (!panelSettings[legacyKey] || panelSettings[nextKey]) continue;
          panelSettings[nextKey] = {
            ...DEFAULT_PANELS[nextKey],
            ...panelSettings[legacyKey],
            name: DEFAULT_PANELS[nextKey]?.name ?? panelSettings[legacyKey].name,
          };
          delete panelSettings[legacyKey];
          migrated = true;
        }
        // Also migrate saved panel order/bottom-set entries for renamed keys
        for (const [legacyKey, nextKey] of keyRenames) {
          for (const orderKey of [PANEL_ORDER_KEY, PANEL_ORDER_KEY + '-bottom-set', PANEL_ORDER_KEY + '-bottom']) {
            try {
              const raw = localStorage.getItem(orderKey);
              if (!raw) continue;
              const arr = JSON.parse(raw);
              if (!Array.isArray(arr)) continue;
              const idx = arr.indexOf(legacyKey);
              if (idx !== -1) { arr[idx] = nextKey; localStorage.setItem(orderKey, JSON.stringify(arr)); migrated = true; }
            } catch { /* corrupt storage, skip */ }
          }
        }
        if (migrated) saveToStorage(STORAGE_KEYS.panels, panelSettings);
        localStorage.setItem(PANEL_KEY_RENAMES_MIGRATION_KEY, 'done');
      }

      // Merge in any panels from ALL_PANELS that didn't exist when settings were saved
      for (const key of Object.keys(ALL_PANELS)) {
        if (!(key in panelSettings)) {
          const config = getEffectivePanelConfig(key, SITE_VARIANT);
          const isInVariant = (VARIANT_DEFAULTS[SITE_VARIANT] ?? []).includes(key);
          panelSettings[key] = { ...config, enabled: isInVariant && config.enabled };
        }
      }

      // One-time migration: expose all panels to existing users (previously variant-gated)
      const UNIFIED_MIGRATION_KEY = 'worldmonitor-unified-panels-v1';
      if (!localStorage.getItem(UNIFIED_MIGRATION_KEY)) {
        const variantDefaults = new Set(VARIANT_DEFAULTS[SITE_VARIANT] ?? []);
        for (const key of Object.keys(ALL_PANELS)) {
          if (!(key in panelSettings)) {
            const config = getEffectivePanelConfig(key, SITE_VARIANT);
            panelSettings[key] = { ...config, enabled: variantDefaults.has(key) && config.enabled };
          }
        }
        saveToStorage(STORAGE_KEYS.panels, panelSettings);
        localStorage.setItem(UNIFIED_MIGRATION_KEY, 'done');
      }

      console.log('[App] Loaded panel settings from storage:', Object.entries(panelSettings).filter(([_, v]) => !v.enabled).map(([k]) => k));

      // One-time migration: reorder panels for existing users (v1.9 panel layout)
      if (!localStorage.getItem(PANEL_ORDER_MIGRATION_KEY)) {
        const savedOrder = localStorage.getItem(PANEL_ORDER_KEY);
        if (savedOrder) {
          try {
            const order: string[] = JSON.parse(savedOrder);
            const priorityPanels = ['insights', 'strategic-posture', 'cii', 'strategic-risk'];
            const filtered = order.filter(k => !priorityPanels.includes(k) && k !== 'live-news');
            const liveNewsIdx = order.indexOf('live-news');
            const newOrder = liveNewsIdx !== -1 ? ['live-news'] : [];
            newOrder.push(...priorityPanels.filter(p => order.includes(p)));
            newOrder.push(...filtered);
            localStorage.setItem(PANEL_ORDER_KEY, JSON.stringify(newOrder));
            console.log('[App] Migrated panel order to v1.9 layout');
          } catch {
            // Invalid saved order, will use defaults
          }
        }
        localStorage.setItem(PANEL_ORDER_MIGRATION_KEY, 'done');
      }
    }

    // Drop saved entries for retired panels so Settings omits dead toggles.
    let droppedRetiredPanel = false;
    for (const key of Object.keys(panelSettings)) {
      if (!key.startsWith('mcp-') && key !== 'social-velocity' && key !== 'wsb-ticker-scanner'
        && !isRetiredPanel(key)) continue;
      delete panelSettings[key];
      droppedRetiredPanel = true;
    }
    if (droppedRetiredPanel && storageAvailable) saveToStorage(STORAGE_KEYS.panels, panelSettings);

    if (storageAvailable) {
      const PANEL_PRUNE_KEY = 'worldmonitor-panel-prune-v2';
      const PANEL_RETIREMENT_KEY = 'worldmonitor-panel-retirement-v2';
      const needsLegacyPrune = !localStorage.getItem(PANEL_PRUNE_KEY);
      const needsPanelRetirement = !safeStorageGet(PANEL_RETIREMENT_KEY);
      if (needsLegacyPrune) {
        let pruned = false;
        for (const key of Object.keys(panelSettings)) {
          if (!Object.prototype.hasOwnProperty.call(ALL_PANELS, key) && !isDynamicPanel(key)) {
            delete panelSettings[key];
            pruned = true;
          }
        }
        if (pruned) saveToStorage(STORAGE_KEYS.panels, panelSettings);
      }
      if (needsLegacyPrune || needsPanelRetirement) {
        for (const orderKey of [PANEL_ORDER_KEY, PANEL_ORDER_KEY + '-bottom-set', PANEL_ORDER_KEY + '-bottom']) {
          try {
            const raw = localStorage.getItem(orderKey);
            if (!raw) continue;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr)) continue;
            const filtered = arr.filter((key: unknown) =>
              typeof key === 'string'
              && !isRetiredPanel(key)
              && (!needsLegacyPrune || Object.prototype.hasOwnProperty.call(ALL_PANELS, key) || isDynamicPanel(key)));
            if (filtered.length !== arr.length) localStorage.setItem(orderKey, JSON.stringify(filtered));
          } catch { localStorage.removeItem(orderKey); }
        }
        if (needsLegacyPrune) localStorage.setItem(PANEL_PRUNE_KEY, 'done');
      }
      if (needsPanelRetirement) {
        for (const panelId of RETIRED_PANEL_IDS) {
          clearPanelSpanEntry(panelId);
          clearPanelColSpanEntry(panelId);
          if (loadPanelCollapsed()[panelId]) savePanelCollapsed(panelId, false);
        }
        safeStorageSet(PANEL_RETIREMENT_KEY, 'done');
      }

      // One-time migration: clear stale panel ordering and sizing state
      if (!localStorage.getItem(LAYOUT_RESET_MIGRATION_KEY)) {
        const hadSavedOrder = !!localStorage.getItem(PANEL_ORDER_KEY);
        const hadSavedSpans = !!localStorage.getItem(PANEL_SPANS_KEY);
        if (hadSavedOrder || hadSavedSpans) {
          localStorage.removeItem(PANEL_ORDER_KEY);
          localStorage.removeItem(PANEL_ORDER_KEY + '-bottom');
          localStorage.removeItem(PANEL_ORDER_KEY + '-bottom-set');
          clearPanelSpans();
          console.log('[App] Applied layout reset migration (v2.5): cleared panel order/spans');
        }
        localStorage.setItem(LAYOUT_RESET_MIGRATION_KEY, 'done');
      }
    }

    const initialUrlState: ParsedMapUrlState | null = parseMapUrlState(window.location.search, mapLayers);
    if (initialUrlState.layers) {
      mapLayers = sanitizeLayersForVariant(initialUrlState.layers, currentVariant as MapVariant);
      initialUrlState.layers = mapLayers;
    }
    if (!CYBER_LAYER_ENABLED) {
      mapLayers.cyberThreats = false;
    }
    // One-time migration: reduce default-enabled sources (full variant only)
    if (currentVariant === 'full' && storageAvailable) {
      const baseKey = 'worldmonitor-sources-reduction-v3';
      if (!localStorage.getItem(baseKey)) {
        const defaultDisabled = computeDefaultDisabledSources();
        saveToStorage(STORAGE_KEYS.disabledFeeds, defaultDisabled);
        localStorage.setItem(baseKey, 'done');
        const total = getTotalFeedCount();
        console.log(`[App] Sources reduction: ${defaultDisabled.length} disabled, ${total - defaultDisabled.length} enabled`);
      }
      const userLang = this.currentSourceCapLanguage();
      // #5949 — re-enable Ukraine/Poland frontline sources for profiles that
      // still have the untouched pre-#5949 default disabled set. An exact-set
      // guard is important here: a customized disabledFeeds set is user
      // intent, and must not be rewritten by the startup migration.
      const frontlineKey = 'worldmonitor-frontline-europe-enable-v1';
      if (!localStorage.getItem(frontlineKey)) {
        const frontline = new Set<string>(FRONTLINE_EUROPE_PROTECTED_SOURCES);
        const legacyDefaultDisabled = new Set(computeLegacyDefaultDisabledSources());
        const legacyCapDisabled = computeCapDisabledSources(
          FEEDS,
          INTEL_SOURCES,
          new Set(computeDefaultDisabledSources()),
          LEGACY_FREE_MAX_SOURCES,
        );
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateFrontlineEuropeDefaultsV3(
          { [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current) },
          legacyDefaultDisabled,
          frontline,
          legacyCapDisabled,
        );
        const updated = JSON.parse(migrated[STORAGE_KEYS.disabledFeeds] as string) as string[];
        if (updated.length !== current.length) {
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log(
            `[App] Frontline Europe enable (#5949): re-enabled ${current.length - updated.length} source(s)`,
          );
        }
        localStorage.setItem(frontlineKey, 'done');
      }
      // #6000 — re-enable strategic defaults for profiles created before the
      // flag became part of the canonical default set. An exact-set guard is
      // required: a customized disabledFeeds set is user intent and must not
      // be rewritten by a startup migration.
      const strategicKey = 'worldmonitor-strategic-defaults-enable-v1';
      if (!localStorage.getItem(strategicKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateStrategicDefaultsV4(
          { [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current) },
          new Set(),
          getStrategicDefaultSources(),
          new Set(),
          buildPreStrategicDefaultDisabledStates(LEGACY_FREE_MAX_SOURCES, userLang),
        );
        const updated = JSON.parse(migrated[STORAGE_KEYS.disabledFeeds] as string) as string[];
        if (updated.length !== current.length) {
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log(
            `[App] Strategic defaults enable (#6000): re-enabled ${current.length - updated.length} source(s)`,
          );
        }
        localStorage.setItem(strategicKey, 'done');
      }
      // #5975/#5976/#5977/#5980 — reconcile the regional feed wave for
      // returning denylist profiles. Exact historical default/cap states are
      // the only eligible inputs; any source customization skips the migration.
      const regionalRolloutKey = 'worldmonitor-regional-feed-rollout-reconcile-v1';
      if (!localStorage.getItem(regionalRolloutKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateRegionalFeedRolloutDefaultsV5(
          { [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current) },
          buildRegionalFeedRolloutMigrationTargets(LEGACY_FREE_MAX_SOURCES, userLang),
        );
        const updated = JSON.parse(migrated[STORAGE_KEYS.disabledFeeds] as string) as string[];
        if (JSON.stringify(updated) !== JSON.stringify(current)) {
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log('[App] Regional feed rollout: restored declared defaults and opt-in boundaries for an untouched profile');
        }
        localStorage.setItem(regionalRolloutKey, 'done');
      }
      // #5960 — Canada + Arctic/Nordic pack: denylist is additive-only, so newly
      // cataloged opt-in names would be implicitly enabled for every returner.
      // Insert opt-ins into any existing denylist once. CBC is intentionally
      // omitted so default-on can enable it for returners (not in old denylist).
      const canadaArcticKey = 'worldmonitor-canada-arctic-optin-v1';
      if (!localStorage.getItem(canadaArcticKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateCanadaArcticOptInsV6({
          [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current),
        }, CANADA_ARCTIC_OPT_IN_SOURCES);
        const rawUpdated = migrated[STORAGE_KEYS.disabledFeeds];
        if (typeof rawUpdated === 'string') {
          let updated: unknown;
          try { updated = JSON.parse(rawUpdated); } catch { updated = null; }
          if (
            Array.isArray(updated)
            && updated.every((name): name is string => typeof name === 'string')
            && JSON.stringify(updated) !== JSON.stringify(current)
          ) {
            saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
            console.log(
              `[App] Canada/Arctic opt-in (#5960): disabled ${updated.length - current.length} newly cataloged source(s)`,
            );
          }
        }
        localStorage.setItem(canadaArcticKey, 'done');
      }
      // #6604/#6605 — Canada depth pack: new opt-in names need a NEW key.
      // Do not reuse worldmonitor-canada-arctic-optin-v1 (already fired).
      const canadaDepthKey = 'worldmonitor-canada-depth-optin-v1';
      if (!localStorage.getItem(canadaDepthKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateCanadaDepthOptInsV7({
          [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current),
        }, CANADA_DEPTH_OPT_IN_SOURCES);
        const rawUpdated = migrated[STORAGE_KEYS.disabledFeeds];
        if (typeof rawUpdated === 'string') {
          let updated: unknown;
          try { updated = JSON.parse(rawUpdated); } catch { updated = null; }
          if (
            Array.isArray(updated)
            && updated.every((name): name is string => typeof name === 'string')
            && JSON.stringify(updated) !== JSON.stringify(current)
          ) {
            saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
            console.log(
              `[App] Canada depth opt-in (#6604/#6605): disabled ${updated.length - current.length} newly cataloged source(s)`,
            );
          }
        }
        localStorage.setItem(canadaDepthKey, 'done');
      }
      // #6813-#6830 — validated crisis desks: preserve every reviewed depth,
      // backup, and locale-primary source as opt-in for returning profiles.
      const crisisDeskOptInKey = 'worldmonitor-crisis-desk-optin-v1';
      if (!localStorage.getItem(crisisDeskOptInKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateCrisisDeskOptInsV8({
          [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current),
        }, CRISIS_FLOOR_OPT_IN_SOURCES);
        const rawUpdated = migrated[STORAGE_KEYS.disabledFeeds];
        if (typeof rawUpdated === 'string') {
          let updated: unknown;
          try { updated = JSON.parse(rawUpdated); } catch { updated = null; }
          if (
            Array.isArray(updated)
            && updated.every((name): name is string => typeof name === 'string')
            && JSON.stringify(updated) !== JSON.stringify(current)
          ) {
            saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
            console.log(
              `[App] Crisis-desk opt-ins (#6813-#6830): disabled ${updated.length - current.length} newly cataloged source(s)`,
            );
          }
        }
        localStorage.setItem(crisisDeskOptInKey, 'done');
      }
      const curatedRegionalOptInKey = 'worldmonitor-curated-regional-optin-v1';
      if (!safeStorageGet(curatedRegionalOptInKey)) {
        const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
        const migrated = migrateCuratedRegionalOptInsV9({
          [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current),
        }, CURATED_REGIONAL_OPT_IN_SOURCES);
        const rawUpdated = migrated[STORAGE_KEYS.disabledFeeds];
        let persisted = true;
        if (typeof rawUpdated === 'string') {
          let updated: unknown;
          try { updated = JSON.parse(rawUpdated); } catch { updated = null; }
          if (
            Array.isArray(updated)
            && updated.every((name): name is string => typeof name === 'string')
            && JSON.stringify(updated) !== JSON.stringify(current)
          ) {
            persisted = saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          }
        }
        if (persisted) safeStorageSet(curatedRegionalOptInKey, 'done');
      }
      const germanRssKey = 'worldmonitor-german-rss-sources-v1';
      if (!safeStorageGet(germanRssKey)) {
        // Missing preferences need persisted defaults; a saved [] is an explicit enable-all choice.
        const current = loadFromStorage<string[] | null>(STORAGE_KEYS.disabledFeeds, null);
        const blob = { [STORAGE_KEYS.disabledFeeds]: JSON.stringify(current ?? computeDefaultDisabledSources(userLang)) };
        const migrated = migrateGermanRssSourcesV10(blob, GERMAN_RSS_SOURCES, userLang);
        const persisted = (current !== null && migrated === blob) || saveToStorage(
          STORAGE_KEYS.disabledFeeds,
          JSON.parse(migrated[STORAGE_KEYS.disabledFeeds] as string) as string[],
        );
        if (persisted) safeStorageSet(germanRssKey, 'done');
      }
      // Locale boost: additively enable locale-matched sources (runs once per locale).
      // Reads the explicit-choice key (`wm-locale-explicit`, written by Settings →
      // Language) before falling back to navigator. Mirrors the i18n.ts:99
      // `wmExplicit` detector — without this, a user whose browser is en-US who
      // picks Magyar in Settings never gets the locale boost (the migration's
      // first run with `userLang='en'` sets `worldmonitor-locale-boost-en` and
      // the `userLang !== 'en'` short-circuit means the boost block never re-fires
      // for any subsequent locale choice). Direct localStorage read because
      // i18next isn't initialized yet here in the constructor — `initI18n()` is
      // called later inside `init()`.
      const localeKey = `worldmonitor-locale-boost-${userLang}`;
      if (userLang !== 'en' && !localStorage.getItem(localeKey)) {
        const boosted = getLocaleBoostedSources(userLang);
        if (boosted.size > 0) {
          const current = loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []);
          const updated = current.filter(name => !boosted.has(name));
          saveToStorage(STORAGE_KEYS.disabledFeeds, updated);
          console.log(`[App] Locale boost (${userLang}): enabled ${current.length - updated.length} sources`);
        }
        localStorage.setItem(localeKey, 'done');
      }
    }

    const disabledSources = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));

    // Build shared state object
    this.state = {
      map: null,
      isMobile,
      container: el,
      panels: {},
      newsPanels: {},
      newsCategoryPanelKeys: new Map(),
      panelSettings,
      mapLayers,
      allNews: [],
      newsByCategory: {},
      latestMarkets: [],
      latestPredictions: [],
      latestClusters: [],
      intelligenceCache: {},
      cyberThreatsCache: null,
      disabledSources,
      currentTimeRange: '7d',
      inFlight: new Set(),
      seenGeoAlerts: new Set(),
      monitors,
      signalModal: null,
      ensureSignalModal: () => this.ensureSignalModal(),
      statusPanel: null,
      searchModal: null,
      findingsBadge: null,
      breakingBanner: null,
      playbackControl: null,
      exportPanel: null,
      unifiedSettings: null,
      pizzintIndicator: null,
      correlationEngine: null,
      countryBriefPage: null,
      countryTimeline: null,
      renewablePanel: null,
      isDestroyed: false,
      isPlaybackMode: false,
      isIdle: false,
      initialLoadComplete: false,
      clustersSettled: false,
      resolvedLocation: 'global',
      activeChokepoint: initialUrlState.chokepoint ?? null,
      pendingCountryBrief: null,
      initialUrlState,
      PANEL_ORDER_KEY,
      PANEL_SPANS_KEY,
    };

    // Instantiate modules (callbacks wired after all modules exist)
    this.refreshScheduler = new RefreshScheduler(this.state);
    this.countryIntel = new CountryIntelManager(this.state);

    this.dataLoader = new DataLoaderManager(this.state, {
      renderCriticalBanner: (postures) => this.panelLayout.renderCriticalBanner(postures),
      refreshOpenCountryBrief: () => this.countryIntel.refreshOpenBrief(),
      refreshOpenCountryMilitary: () => this.countryIntel.refreshOpenMilitaryActivity(),
      refreshOpenCountryTimeline: () => this.countryIntel.refreshOpenTimeline(),
    });

    this.panelLayout = new PanelLayoutManager(this.state, {
      openCountryStory: (code, name) => {
        void this.countryIntel.openCountryStory(code, name).catch((err) => {
          console.error('[CountryStory] Failed to open story:', err);
          showToast('Country story failed to open. Please try again.');
        });
      },
      openCountryBrief: (code) => {
        const name = CountryIntelManager.resolveCountryName(code);
        void this.countryIntel.openCountryBriefByCode(code, name).catch((err) => {
          console.error('[CountryBrief] Failed to open country brief:', err);
          showToast('Country brief failed to open. Please try again.');
        });
      },
      openSearch: () => {
        void this.openSearch();
      },
      loadAllData: (forceAll, trigger) => this.dataLoader.loadAllData(forceAll, trigger),
      primeVisiblePanelData: () => {
        if (!this.viewportHydrationReady || this.state.isDestroyed) return;
        void this.primeVisiblePanelData();
      },
      updateMonitorResults: () => this.dataLoader.updateMonitorResults(),
      loadSecurityAdvisories: () => this.dataLoader.loadSecurityAdvisories(),
      applyMapLayerChange: (layer, enabled, source) => this.eventHandlers.applyMapLayerChange(layer, enabled, source),
    });

    this.eventHandlers = new EventHandlerManager(this.state, {
      openSearch: (options) => { void this.openSearch(options); },
      updateSearchIndex: () => this.updateSearchIndexIfReady(),
      loadAllData: () => this.dataLoader.loadAllData(),
      invalidateNewsHydration: () => this.dataLoader.invalidateNewsHydration(),
      flushStaleRefreshes: () => this.refreshScheduler.flushStaleRefreshes(),
      setHiddenSince: (ts) => this.refreshScheduler.setHiddenSince(ts),
      loadDataForLayer: (layer) => { void this.dataLoader.loadDataForLayer(layer as keyof MapLayers); },
      waitForAisData: () => this.dataLoader.waitForAisData(),
      syncDataFreshnessWithLayers: () => this.dataLoader.syncDataFreshnessWithLayers(),
      applyPanelSettings: () => this.panelLayout.applyPanelSettings(),
      applySavedPanelOrder: (panelOrder?: string[]) => this.panelLayout.applySavedPanelOrder(panelOrder),
      mountLiveNewsIfReady: () => this.panelLayout.mountLiveNewsIfReady(),
      focusStorageFacility: (facilityId) => this.panelLayout.focusStorageFacility(facilityId),
      promptForFocus: () => this.panelLayout.promptForFocus(),
      updateFlightSource: (adsb, military) => this.updateFlightSourceIfReady(adsb, military),
    });

    // Wire cross-module callback: DataLoader → SearchManager
    this.dataLoader.updateSearchIndex = () => this.updateSearchIndexIfReady();

    // Track destroy order (reverse of init)
    this.modules = [
      this.panelLayout,
      this.countryIntel,
      this.dataLoader,
      this.refreshScheduler,
      this.eventHandlers,
    ];
  }

  private ensureSignalModal(): Promise<SignalModalInstance> {
    if (this.state.signalModal) return Promise.resolve(this.state.signalModal);
    if (this.signalModalLoad) return this.signalModalLoad;

    this.signalModalLoad = import('@/components/SignalModal')
      .then(({ SignalModal }) => {
        if (this.state.isDestroyed) {
          throw new Error('App destroyed before signal modal loaded');
        }
        const signalModal = new SignalModal();
        signalModal.setLocationClickHandler((lat, lon) => {
          this.state.map?.setCenter(lat, lon, 4);
        });
        this.state.signalModal = signalModal;
        return signalModal;
      })
      .catch((err) => {
        this.signalModalLoad = null;
        throw err;
      });

    return this.signalModalLoad;
  }

  private ensureSearchManager(): Promise<SearchManager> {
    if (this.searchManager) return Promise.resolve(this.searchManager);
    if (this.searchManagerLoad) return this.searchManagerLoad;

    this.searchManagerLoad = import('@/app/search-manager')
      .then(async ({ SearchManager }) => {
        if (this.state.isDestroyed) {
          throw new Error('App destroyed before search manager loaded');
        }

        const manager = new SearchManager(this.state, {
          openCountryBriefByCode: (code, country, options) => (
            this.openCountryBriefWithAcknowledgement(code, country, {
              trackAnalytics: options?.trackDetailedAnalytics !== false,
              signal: options?.signal,
            })
          ),
          enablePanel: (panelId) => this.eventHandlers.enablePanelById(panelId),
        });
        manager.init();
        if (this.state.isDestroyed) {
          manager.destroy();
          throw new Error('App destroyed while search manager loaded');
        }
        manager.updateFlightSource(
          this.latestSearchAdsb,
          this.latestSearchMilitary,
          this.latestSearchAdsbUpdatedAt,
        );
        this.searchManager = manager;
        this.modules.push(manager);
        return manager;
      })
      .finally(() => {
        this.searchManagerLoad = null;
      });

    return this.searchManagerLoad;
  }

  private openCountryBriefWithAcknowledgement(
    code: string,
    country: string,
    options: { trackAnalytics: boolean; signal?: AbortSignal; owner?: 'agent' | 'human' },
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      let acknowledged = false;
      const cleanup = (): void => {
        options.signal?.removeEventListener('abort', handleAbort);
      };
      const finish = (opened: boolean): void => {
        if (acknowledged) return;
        acknowledged = true;
        cleanup();
        resolve(opened);
      };
      const fail = (error: unknown): void => {
        if (acknowledged) return;
        acknowledged = true;
        cleanup();
        if (
          options.signal?.aborted
          || isWebMcpAbortError(error)
        ) {
          reject(error);
          return;
        }
        console.error('[CountryBrief] Failed to open country brief:', error);
        showToast('Country brief failed to open. Please try again.');
        resolve(false);
      };
      const handleAbort = (): void => {
        try {
          throwIfWebMcpAborted(options.signal);
        } catch (error) {
          fail(error);
        }
      };

      try {
        throwIfWebMcpAborted(options.signal);
      } catch (error) {
        fail(error);
        return;
      }
      options.signal?.addEventListener('abort', handleAbort, { once: true });
      void this.countryIntel.openCountryBriefByCode(code, country, {
        trackAnalytics: options.trackAnalytics,
        signal: options.signal,
        owner: options.owner,
        onPresented: () => {
          const page = this.state.countryBriefPage;
          finish(page?.isVisible() === true && page.getCode() === code);
        },
      }).then(() => {
        // A superseded, destroyed, or failed open can settle without ever
        // presenting the requested page.
        finish(false);
      }).catch(fail);
    });
  }

  private async openWebMcpCountryBrief(
    code: string,
    country: string,
    execution?: WebMcpExecutionOptions,
  ): Promise<boolean> {
    await this.waitForUiReady(execution?.signal);
    throwIfWebMcpAborted(execution?.signal);
    return this.openCountryBriefWithAcknowledgement(code, country, {
      trackAnalytics: false,
      signal: execution?.signal,
      // No shipping browser hands WebMCP tools a target-side AbortSignal, so
      // ownership must be stated rather than inferred from execution.signal —
      // otherwise this agent open claims 'human' and skips the arbitration
      // that keeps it from evicting an in-flight human request.
      owner: 'agent',
    });
  }

  private updateSearchIndexIfReady(): void {
    this.searchManager?.updateSearchIndex();
  }

  private updateFlightSourceIfReady(
    adsb: Parameters<SearchManager['updateFlightSource']>[0],
    military: Parameters<SearchManager['updateFlightSource']>[1],
  ): void {
    this.latestSearchAdsb = adsb;
    this.latestSearchMilitary = military;
    // This callback is driven by the DeckGL ADS-B viewport feed. Military
    // tracks are copied from their independent cache and retain freshness via
    // each track's lastSeen; never stamp them with this ADS-B observation time.
    this.latestSearchAdsbUpdatedAt = Date.now();
    this.searchManager?.updateFlightSource(adsb, military, this.latestSearchAdsbUpdatedAt);
  }

  private async openSearch(options: {
    toggle?: boolean;
    throwOnFailure?: boolean;
    replaceOverlayId?: OverlayId;
    historyPending?: boolean;
    signal?: AbortSignal;
    initialQuery?: string;
  } = {}): Promise<boolean> {
    // Concurrency model: each press registers its intent, then claims a
    // monotonic epoch. After the lazy load resolves, only the latest epoch acts
    // — superseded presses bail. This yields one deterministic modal.open() for
    // any Cmd+K / button interleaving during the first load (replacing the prior
    // two-field pending-toggle bookkeeping), while preserving net-toggle parity:
    // the XOR flip happens BEFORE the epoch claim so every rapid Cmd+K still
    // counts (odd → open, even → cancel), even the ones that get superseded.
    let epoch = this.openSearchEpoch;
    const pendingId: OverlayId = 'search-pending';
    const pendingGate = options.historyPending
      ? overlayHistory.beginPending(pendingId, options.replaceOverlayId, () => {
          this.searchToggleDesiredOpen = false;
        })
      : null;
    try {
      await this.waitForUiReady(options.signal);
      throwIfWebMcpAborted(options.signal);
      // A fresh palette intent (human Cmd+K/button or agent open_search)
      // supersedes any older open_search_result presentation before we decide
      // whether to toggle, lazy-load, or open the modal. This cancellation is
      // intentionally limited to agent selection work; it does not clear the
      // palette's query/debounce state or unrelated human actions.
      this.searchManager?.cancelPendingProgrammaticSelection();
      if (pendingGate && !pendingGate.isCurrent()) return false;

      const existingModal = this.state.searchModal;
      if (options.toggle && existingModal?.isOpen()) {
        existingModal.close();
        return false;
      }

      const togglingBeforeLoad = Boolean(options.toggle) && !this.searchManager;
      if (togglingBeforeLoad) {
        this.searchToggleDesiredOpen = !this.searchToggleDesiredOpen;
      }

      epoch = ++this.openSearchEpoch;
      const manager = await raceWebMcpAbort(this.ensureSearchManager(), options.signal);
      throwIfWebMcpAborted(options.signal);
      if (this.openSearchEpoch !== epoch) return false;
      if (pendingGate && !pendingGate.isCurrent()) return false;

      const wantOpen = togglingBeforeLoad ? this.searchToggleDesiredOpen : true;
      if (!wantOpen) return false;

      manager.updateSearchIndex();
      const modal = this.state.searchModal;
      if (!modal) throw new Error('Search modal is not initialised');
      throwIfWebMcpAborted(options.signal);
      modal.open(pendingGate ? pendingId : options.replaceOverlayId);
      if (options.initialQuery) modal.applyQuery(options.initialQuery);
      return modal.isOpen();
    } catch (error) {
      const actionWasCancelled = pendingGate !== null && !pendingGate.isCurrent();
      const invocationWasCancelled = options.signal?.aborted === true;
      if (!this.state.isDestroyed && !actionWasCancelled && !invocationWasCancelled) {
        console.warn('[search] Failed to load search manager:', error);
        if (!options.throwOnFailure) showToast('Search failed to load. Please try again.');
      }
      pendingGate?.cancel();
      if (options.throwOnFailure || options.signal?.aborted) throw error;
      return false;
    } finally {
      // Reset the toggle accumulator once the latest press settles.
      if (this.openSearchEpoch === epoch) this.searchToggleDesiredOpen = false;
    }
  }

  private async waitForSlowBootstrapCheckpoint(): Promise<boolean> {
    markLcpDebug('wm:data:slow-tier-wait-start');
    try {
      const settled = await waitForBootstrapSlowTier(3_500);
      markLcpDebug('wm:data:slow-tier-wait-end', { settled });
      if (this.state.isDestroyed) return settled;
      this.bootstrapHydrationState = getBootstrapHydrationState();
      this.updateConnectivityUi();
      return settled;
    } catch {
      markLcpDebug('wm:data:slow-tier-wait-error');
      return false;
    }
  }

  private completePendingSlowTierFanout(): void {
    if (!this.slowTierWaitTimedOut || this.state.isDestroyed) return;
    this.slowTierWaitTimedOut = false;
    void this.runVisibleDataFanout();
  }

  private async runVisibleDataFanout(): Promise<void> {
    if (this.viewportHydrationReady || this.state.isDestroyed) return;
    this.viewportHydrationReady = true;
    window.addEventListener('scroll', this.handleViewportPrime, {
      passive: true,
      capture: true,
    });
    window.addEventListener('resize', this.handleViewportPrime);
    markLcpDebug('wm:data:initial-fanout-start');
    await Promise.all([
      this.dataLoader.loadAllData(),
      this.primeVisiblePanelData(),
    ]);
    markLcpDebug('wm:data:initial-fanout-complete');
    if (this.state.isDestroyed) return;
    this.viewportHydrationReadyAt = typeof performance !== 'undefined' &&
      typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
    this.viewportTriggersArmed = true;
    void this.primeVisiblePanelData();
    if (import.meta.env.VITE_E2E === '1') {
      document.documentElement.dataset.wmInitialDataReady = 'true';
    }
  }

  private async preloadCountryGeometryForPostLcpWork(): Promise<void> {
    markLcpDebug('wm:data:country-geometry-start');
    try {
      await preloadCountryGeometry();
      markLcpDebug('wm:data:country-geometry-ready');
    } catch {
      markLcpDebug('wm:data:country-geometry-error');
    }
  }

  private startPostLcpIntelligence(countryGeometryReady: Promise<void>, geometryAlreadyApplied: boolean): void {
    void countryGeometryReady.finally(() => {
      if (this.state.isDestroyed) return;
      // Replay geometry-dependent country-detail data only when the fan-out ingested before
      // precision geometry was ready; otherwise the first-pass attribution is
      // already correct and a replay is a redundant compute + repaint (#4512).
      if (!geometryAlreadyApplied) {
        this.dataLoader.refreshGeometryDependentCountryData();
      }
      // Correlation and country-learning use precision geometry/name matching,
      // but they are post-initial-data work and should not hold the LCP path.
      void this.loadInitialCorrelationEngine();
      startLearning();
    });
  }

  private async loadInitialCorrelationEngine(): Promise<void> {
    try {
      const {
        CorrelationEngine,
        militaryAdapter,
        escalationAdapter,
        economicAdapter,
        disasterAdapter,
      } = await import('@/services/correlation-engine');

      if (this.state.isDestroyed) return;
      const engine = new CorrelationEngine();
      engine.registerAdapter(militaryAdapter);
      engine.registerAdapter(escalationAdapter);
      engine.registerAdapter(economicAdapter);
      engine.registerAdapter(disasterAdapter);
      this.state.correlationEngine = engine;
      this.connectCorrelationAssessments();

      await this.runCorrelationEngine();
    } catch (error) {
      console.warn('[CorrelationEngine] Initial lazy load/run failed:', error);
    }
  }

  private connectCorrelationAssessments(): void {
    const engine = this.state.correlationEngine;
    if (!engine) return;
    for (const domain of CORRELATION_DOMAINS) {
      const panel = this.state.panels[`${domain}-correlation`] as CorrelationPanel | undefined;
      panel?.setAssessmentHandler(cards => engine.assessCards(domain, cards));
    }
  }

  private async runCorrelationEngine(): Promise<void> {
    const engine = this.state.correlationEngine;
    if (!engine || this.state.isDestroyed) return;

    const { fetchCorrelationRuntimeMode } = await import('@/services/correlation-runtime-mode');
    const runtimeMode = await fetchCorrelationRuntimeMode();
    if (this.state.isDestroyed) return;

    // run() reports false when it skipped because a run was already in flight.
    // Not reachable today (run() never yields), but this diff put two awaits in
    // front of it, so honour the contract rather than publishing getCards() —
    // which on a first-run overlap would write empty cards into live panels.
    const didRun = await engine.run(this.state, runtimeMode);
    if (!didRun || this.state.isDestroyed) return;
    for (const domain of CORRELATION_DOMAINS) {
      const panel = this.state.panels[`${domain}-correlation`] as CorrelationPanel | undefined;
      panel?.updateCards(engine.getCards(domain));
    }
  }

  public getWebMcpBindings(): WebMcpAppBindings {
    return {
      openCountryBriefByCode: (code, country, execution) => (
        this.openWebMcpCountryBrief(code, country, execution)
      ),
      resolveCountryName: (code) => CountryIntelManager.resolveCountryName(code),
      openSearch: async (execution) => {
        // openSearch() awaits UI readiness internally and throws on failure when
        // throwOnFailure is set, so the agent receives a real success/failure.
        // (Re-checking searchModal here would spuriously throw if a concurrent
        // Cmd+K closed it between open and the check — #4403 review ADV-4.)
        return this.openSearch({ throwOnFailure: true, signal: execution?.signal });
      },
      getDashboardContext: async (execution) => {
        await this.waitForDashboardReady(true, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return getWebMcpDashboardContext(this.state, SITE_VARIANT);
      },
      listMapLayerCatalog: async (execution) => {
        await this.waitForDashboardReady(true, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return getWebMcpMapLayerCatalogSnapshot(
          this.state,
          SITE_VARIANT,
          true,
          t,
          this.getMapLayerRuntimeAvailability(),
        );
      },
      listDashboardPanels: async (query, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return listWebMcpDashboardPanels(this.state, SITE_VARIANT, query, {
          isPanelAllowed: () => true,
        });
      },
      switchMonitor: async (monitor, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return applyWebMcpSwitchMonitor(
          this.state,
          SITE_VARIANT,
          monitor,
          (variant) => this.eventHandlers.navigateToVisibleVariant(variant),
        );
      },
      openSettings: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return applyWebMcpOpenSettings(this.state, SITE_VARIANT);
      },
      openAlerts: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return applyWebMcpOpenAlerts(this.state, SITE_VARIANT);
      },
      applyDashboardAction: async (action, execution) => {
        return runDashboardActionBinding(this.state, action, {
          waitForUiReady: () => this.waitForDashboardReady(false, execution?.signal),
          waitForMapReady: () => this.waitForDashboardReady(true, execution?.signal),
          getMapAuthorityToken: () => this.state.map?.getViewportAuthorityToken() ?? 0,
          signal: execution?.signal,
          applierOptions: {
            getPanelConfig: (panelId) => getEffectivePanelConfig(panelId, SITE_VARIANT),
            getMapLayerRuntimeAvailability: this.getMapLayerRuntimeAvailability,
            applyLayerChange: (layer, enabled, source) => (
              this.eventHandlers.applyMapLayerChange(layer, enabled, source)
            ),
          },
          syncUrlStateNow: () => this.eventHandlers.syncUrlStateNow(),
        });
      },
      selectPanelTab: async (panelId, tab, execution) => {
        return selectWebMcpPanelTab(this.state.panels, panelId, tab, {
          waitForUiReady: () => this.waitForDashboardReady(false, execution?.signal),
          prepareTab: (_selectedPanelId, selectedTab, signal) => (
            selectedTab === 'physical'
              ? this.dataLoader.loadPhysicalPremiumComparison(signal)
              : undefined
          ),
          signal: execution?.signal,
        });
      },
      searchDashboard: async (query, scope, limit, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        let manager: SearchManager;
        try {
          manager = await raceWebMcpAbort(
            this.ensureSearchManager(),
            execution?.signal,
          );
          throwIfWebMcpAborted(execution?.signal);
        } catch (error) {
          if (this.state.isDestroyed) {
            throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
          }
          throw error;
        }
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        const result = await manager.searchDashboard(
          query,
          scope,
          limit,
          execution?.signal,
        );
        throwIfWebMcpAborted(execution?.signal);
        return result;
      },
      openSearchResult: async (resultKey, execution) => {
        // A capability can only exist after search_dashboard initialized the
        // manager. Deny fabricated first-use keys without loading the lazy
        // search chunk or demanding a map renderer.
        const manager = this.searchManager;
        if (!manager) {
          return { ok: false, status: 'denied', reason: 'invalid_or_expired_key' } as const;
        }
        await this.waitForUiReady(execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return manager.openSearchResult(
          resultKey,
          () => this.waitForDashboardReady(true, execution?.signal),
          execution?.signal,
        );
      },
      applyDashboardTabAction: async (action, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.applyWebMcpTabAction(action);
      },
      setPanelEnabled: async (panelId, enabled, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        const result = this.eventHandlers.setPanelEnabledById(panelId, enabled);
        // Map uses #mapSection, not ctx.panels / [data-panel]. After persist,
        // do not abort on the caller signal: cancellation-required only gates a
        // missing signal. The App lifecycle signal still cancels this waiter
        // when destroy() runs, so a same-document re-init cannot wake the
        // MutationObserver on replacement DOM.
        if (
          result.ok
          && result.changed
          && result.effectiveEnabled
          && typeof panelId === 'string'
          && panelId !== 'map'
        ) {
          try {
            await waitUntilPanelLive({
              isLive: () => isCatalogPanelLive(panelId, this.state.panels),
              signal: this.lifecycleController.signal,
            });
          } catch (error) {
            if (this.state.isDestroyed || this.lifecycleController.signal.aborted) {
              throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
            }
            throw error;
          }
        }
        return result;
      },
      listMissionPresets: async (query, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return listWebMcpMissionPresets(this.state, SITE_VARIANT, query, {
          hasPremium: true,
          hasFocus: true,
          isPanelEntitled: () => true,
        });
      },
      applyMissionPreset: async (presetId, execution) => {
        await this.waitForDashboardReady(true, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return applyWebMcpMissionPreset(this.state, SITE_VARIANT, presetId, {
          hasPremium: true,
          hasFocus: true,
          isPanelEntitled: () => true,
          apply: (id) => this.eventHandlers.applyMissionPresetForWebMcp(id),
        });
      },
      openMissionPicker: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        return applyWebMcpOpenMissionPicker(
          this.state,
          SITE_VARIANT,
          () => this.eventHandlers.openMissionPresetPickerForWebMcp(),
        );
      },
      listFollowedCountries: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        const countries = getFollowed();
        return {
          ok: true,
          enabled: isFollowFeatureEnabled(),
          countries,
          count: countries.length,
          access: serviceEntitlementState(),
          limit: null,
        };
      },
      setCountryFollowed: async (iso2, followed, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        if (typeof followed !== 'boolean') {
          return {
            ok: false,
            status: 'invalid',
            reason: 'malformed_arguments',
            message: 'followed must be a boolean.',
          };
        }
        const code = typeof iso2 === 'string' ? iso2.trim().toUpperCase() : '';
        const wasFollowed = isFollowed(code);
        const result = await (followed ? addCountry(code) : removeCountry(code));
        throwIfWebMcpAborted(execution?.signal);
        if (result.ok) {
          return {
            ok: true,
            status: wasFollowed === followed ? 'unchanged' : 'accepted',
            iso2: code,
            followed,
            message: wasFollowed === followed
              ? `Country ${code} already has the requested followed state.`
              : `Country ${code} followed state change was accepted.`,
          };
        }
        switch (result.reason) {
          case 'INVALID_INPUT':
            return {
              ok: false,
              status: 'invalid',
              reason: 'invalid_country',
              followed,
              message: 'iso2 must identify a supported country.',
            };
          case 'STORAGE_FULL':
            return {
              ok: false,
              status: 'denied',
              iso2: code,
              followed,
              reason: 'storage_full',
              message: 'The browser could not save the followed-country state.',
            };
          case 'DISABLED':
            return {
              ok: false,
              status: 'denied',
              iso2: code,
              followed,
              reason: 'disabled',
              message: 'Followed countries are not available on this dashboard.',
            };
        }
      },
      getPanelLayout: async (execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.getPanelLayoutSnapshot();
      },
      setPanelCollapsed: async (panelId, collapsed, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.applyWebMcpSetPanelCollapsed(panelId, collapsed);
      },
      movePanel: async (panelId, region, index, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.applyWebMcpMovePanel(panelId, region, index);
      },
      setPanelFullscreen: async (panelId, fullscreen, execution) => {
        await this.waitForDashboardReady(false, execution?.signal);
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return this.panelLayout.applyWebMcpSetPanelFullscreen(panelId, fullscreen);
      },
      getAccessContext: async (execution) => {
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        return buildWebMcpAccessContext({
          enabledPanelUsed: Object.values(this.state.panelSettings).filter((panel) => panel.enabled).length,
          dashboardTabCount: this.panelLayout.getDashboardTabCount(),
        });
      },
      openSignIn: async (execution) => {
        throwIfWebMcpAborted(execution?.signal);
        if (this.state.isDestroyed) {
          throw new DashboardBindingError('app_destroyed', 'Dashboard is no longer available.');
        }
        // There is no account to sign in to.
        return { ok: false, status: 'denied', reason: 'clerk_unavailable' };
      },
    };
  }

  public async init(webMcpController: AbortController | null): Promise<void> {
    markLcpDebug('wm:boot:app-init-start');

    // src/main.ts registers WebMCP before loading App. Own its controller before
    // the first await so a failed init unregisters those tools through destroy().
    this.webMcpController = webMcpController;

    window.addEventListener(I18N_RESOURCES_LOADED_EVENT, this.handleI18nResourcesLoaded);

    // IndexedDB and the locale bundles are independent (i18n reads only
    // localStorage and the URL), so the locale loads while the database opens.
    // A failed load is still thrown below, where it is awaited.
    const i18nReady = initI18n();
    i18nReady.catch(() => {});
    await openStorageForBoot();
    startFlightHistoryCleanup();
    // Re-arm the lazy vessel runtime (a no-op on first boot; matters on a
    // same-document re-init after a prior App.destroy() disarmed it). The
    // history-cleanup interval itself still starts lazily on first vessel use.
    enableVesselRuntime();
    await i18nReady;
    markLcpDebug('wm:boot:i18n-ready');
    initDeferredDashboardFonts();
    // Localize the static index.html shell — <title>, meta description, and
    // the accessible <h1> are baked in English before the app boots; once i18n
    // is ready we swap them to the user's locale.
    document.title = t('shell.documentTitle');
    const setMeta = (sel: string, val: string) => {
      const el = document.querySelector(sel);
      if (el) el.setAttribute('content', val);
    };
    setMeta('meta[name="description"]', t('shell.metaDescription'));
    setMeta('meta[property="og:title"]', t('shell.documentTitle'));
    setMeta('meta[property="og:description"]', t('shell.metaDescription'));
    setMeta('meta[name="twitter:title"]', t('shell.documentTitle'));
    setMeta('meta[name="twitter:description"]', t('shell.metaDescription'));
    // Mirror of OG_LOCALE in pro-test/src/i18n.ts. The two packages have
    // separate Vite roots and bundlers and can't share an import — keep the
    // tables aligned by hand when adding a locale here OR there.
    const ogLocaleMap: Record<string, string> = {
      en: 'en_US', bg: 'bg_BG', cs: 'cs_CZ', fr: 'fr_FR', de: 'de_DE', el: 'el_GR',
      es: 'es_ES', hr: 'hr_HR', hu: 'hu_HU', it: 'it_IT', pl: 'pl_PL', pt: 'pt_BR',
      nl: 'nl_NL', sv: 'sv_SE', ru: 'ru_RU', uk: 'uk_UA', ar: 'ar_SA', fa: 'fa_IR', zh: 'zh_CN',
      'zh-TW': 'zh_TW',
      ja: 'ja_JP', ko: 'ko_KR', ro: 'ro_RO', tr: 'tr_TR', th: 'th_TH', vi: 'vi_VN',
      hi: 'hi_IN', sw: 'sw_TZ',
    };
    // Look the full tag up first: a region-bearing locale (zh-TW) has its own
    // entry above that a region-stripped key would never reach.
    const docLang = document.documentElement.lang || 'en';
    const baseLang = docLang.split('-')[0] || 'en';
    setMeta('meta[property="og:locale"]', ogLocaleMap[docLang] || ogLocaleMap[baseLang] || `${baseLang}_${baseLang.toUpperCase()}`);
    const srH1 = document.querySelector('body > h1');
    if (srH1) srH1.textContent = t('shell.documentTitle');
    const aiFlow = getAiFlowSettings();
    // Optional local AI initializes independently of the dashboard critical
    // path (#7779): boot proceeds to layout, event handlers and basic panels
    // immediately; the worker settles in the background. The epoch guards
    // detached continuations: disable/destroy during capability detection,
    // worker startup or model restoration resolves late continuations as false
    // instead of downloading models or restarting for a dead app generation.
    // destroy() bumps the epoch first, so a stale continuation from a
    // torn-down App can never load a model into the shared worker a fresh
    // same-document App reuses. The failed/unavailable path leaves the
    // dashboard usable; explicit AI operations fail visibly through the
    // manager's readiness promises instead.
    const localAiEpoch = this.localAiInitEpoch;
    // Same authority as before: browserModel on web, unconditional on desktop.
    // Headline Memory needs no extra disjunct — on web its effective gate
    // already requires browserModel, on desktop the runtime check covers it.
    if (aiFlow.browserModel) {
      void (async () => {
        try {
          const ready = await mlWorker.init();
          if (this.localAiInitEpoch !== localAiEpoch || this.state.isDestroyed) return;
          if (!ready) return;
          if (!getAiFlowSettings().browserModel) return;
          if (BETA_MODE) mlWorker.loadModel('summarization-beta').catch(() => { });
        } catch {
          // Worker failure must not break boot; explicit AI operations fail
          // visibly through the manager's readiness promises instead.
        }
      })();
    }

    // Headline Memory requires Browser Local Model to be ON — `isHeadlineMemoryEnabled()`
    // ANDs both flags. Without this gate, leaving Headline Memory on while turning
    // Browser Local Model off would silently download/run an embeddings model the user
    // opted out of via the parent toggle. Joins the detached boot continuation
    // above (shared in-flight init, no duplicate worker): on slow workers this
    // waits without blocking layout or panels.
    if (isHeadlineMemoryEnabled()) {
      void mlWorker.whenReady('app-boot:headline-memory').then((ready) => {
        if (!ready) return;
        if (this.localAiInitEpoch !== localAiEpoch || this.state.isDestroyed) return;
        if (!isHeadlineMemoryEnabled()) return;
        mlWorker.loadModel('embeddings').catch(() => { });
      }).catch(() => { });
    }

    this.unsubAiFlow = subscribeAiFlowChange((key) => {
      // Detached continuations re-read current settings and the app lifetime
      // before requesting a model: a toggle that went away while the worker
      // was starting must not leave a model downloading (#7779).
      if (key === 'browserModel') {
        const s = getAiFlowSettings();
        if (s.browserModel) {
          // init(), not whenReady(): cold-boot with the toggle off leaves the
          // manager disabled, and whenReady() on a disabled manager resolves
          // false without starting anything — the enable path must START the
          // worker (#7796 review P1). init() is idempotent over an already
          // running worker, so a racing boot continuation cannot duplicate it.
          const epoch = this.localAiInitEpoch;
          void mlWorker.init().then((ready) => {
            if (!ready) return;
            if (this.localAiInitEpoch !== epoch || this.state.isDestroyed) return;
            // Re-honor Headline Memory's persisted value on parent re-enable.
            if (isHeadlineMemoryEnabled()) {
              mlWorker.loadModel('embeddings').catch(() => { });
            }
          }).catch(() => { });
        } else {
          // Browser Local Model is the parent toggle for ALL local-model use,
          // including Headline Memory. Terminate unconditionally on web —
          // any persisted Headline Memory value is now non-effective.
          mlWorker.terminate();
        }
      }
      if (key === 'headlineMemory') {
        if (isHeadlineMemoryEnabled()) {
          // init(), not whenReady(): Headline Memory can be toggled on while
          // the manager was never started (web boot with browserModel off) —
          // waiting would resolve false without starting anything, and its
          // effective gate already implies the parent toggle (#7796 review P1).
          const epoch = this.localAiInitEpoch;
          void mlWorker.init().then((ready) => {
            if (!ready) return;
            if (this.localAiInitEpoch !== epoch || this.state.isDestroyed) return;
            if (!isHeadlineMemoryEnabled()) return;
            mlWorker.loadModel('embeddings').catch(() => { });
          }).catch(() => { });
        } else {
          mlWorker.unloadModel('embeddings').catch(() => { });
          const s = getAiFlowSettings();
          if (!s.browserModel) {
            mlWorker.terminate();
          }
        }
      }
    });

    // Check AIS configuration before init
    if (!isAisConfigured()) {
      this.state.mapLayers.ais = false;
    } else if (this.state.mapLayers.ais) {
      initAisStream();
    }

    // Wait for sidecar readiness on desktop so bootstrap hits a live server.
    // Consume the result: a sidecar that never answered its own health probe
    // should leave a signal rather than being silently treated as ready (#6779).

    // Hydrate in-memory cache from bootstrap endpoint. Awaits only the fast tier; the slow
    // tier loads in the background (off the first-paint critical path, #4488) and calls back
    // when it lands so the connectivity indicator re-snapshots (no reactive emitter exists).
    await fetchBootstrapData(() => {
      if (this.state.isDestroyed) return;
      this.bootstrapHydrationState = getBootstrapHydrationState();
      this.updateConnectivityUi();
      this.completePendingSlowTierFanout();
    });
    markLcpDebug('wm:boot:fast-bootstrap-ready');
    this.bootstrapHydrationState = getBootstrapHydrationState();

    // Install the followed-countries listeners once (picker global and
    // cross-tab storage fan-out). Idempotent.
    installFollowedCountriesListeners();
    this.restoreGateOwnedPreferences();

    const geoCoordsPromise: Promise<PreciseCoordinates | null> =
      this.state.isMobile && this.state.initialUrlState?.lat === undefined && this.state.initialUrlState?.lon === undefined
        ? resolvePreciseUserCoordinates(5000)
        : Promise.resolve(null);

    // Readiness must not wait for permission/position work (#7778): seed the
    // initial region synchronously from usable cached region/coordinates, else
    // timezone, else global (desktop map startup stays global because layout
    // reads this value before the background refinement below can land), then
    // let the shared in-flight lookup refine it in the background without
    // gating layout or event-handler setup. Desktop keeps its prior
    // region-ranked predictions via the same background path; only the map
    // view and the precise recenter stay mobile-only.
    this.state.resolvedLocation = initialRegionFromCache(this.state.isMobile);
    void resolveUserRegion().then(
      (region) => {
        if (this.state.isDestroyed) return;
        this.applyLateGeoRegion(region);
      },
      () => { /* failed location keeps the synchronous fallback usable */ },
    );

    // Phase 1: Layout (creates map + panels — they'll find hydrated data).
    // init() is async so the dynamic MapContainer import can resolve before
    // downstream code (e.g. mobileGeoCoords→state.map.setCenter) reads ctx.map.
    markLcpDebug('wm:layout:init-start');
    await this.panelLayout.init();
    markLcpDebug('wm:layout:init-complete');
    this.eventHandlers.setupSearchControls();
    this.updateConnectivityUi();
    window.addEventListener('online', this.handleConnectivityChange);
    window.addEventListener('offline', this.handleConnectivityChange);

    // The single automatic precise recenter for this startup (mobile only,
    // never desktop) runs as background work so a slow position lookup never
    // blocks layout, event-handler, or data readiness (#7778). It fires only
    // while the app is alive and no explicit URL view/coordinates or
    // user/programmatic navigation has claimed the camera since layout: the
    // authority snapshot below is taken after map construction, and any later
    // pan/zoom (humanViewportInteractionToken), preset, search, or country
    // navigation supersedes it.
    const recenterAuthorityToken = this.state.map?.getViewportAuthorityToken() ?? 0;
    const urlClaimedCamera = this.state.initialUrlState != null && (
      this.state.initialUrlState.view !== undefined ||
      (this.state.initialUrlState.lat !== undefined && this.state.initialUrlState.lon !== undefined)
    );
    void geoCoordsPromise.then((mobileGeoCoords) => {
      if (!mobileGeoCoords || this.state.isDestroyed) return;
      if (!this.state.isMobile || this.autoGeoRecenterApplied || urlClaimedCamera) return;
      const map = this.state.map;
      if (!map || map.getViewportAuthorityToken() !== recenterAuthorityToken) return;
      this.autoGeoRecenterApplied = true;
      map.setCenter(mobileGeoCoords.lat, mobileGeoCoords.lon, 6);
    });

    // Phase 2: Shared UI components
    if (!this.state.isMobile) {
      void this.initFindingsBadge();
    }

    initBreakingNewsAlerts();
    // The world first screen has its own breaking-news row; the banner comes with the full view.
    if (!this.panelLayout.isWorldMode()) this.state.breakingBanner = new BreakingNewsBanner();

    // Phase 3: UI setup methods
    this.eventHandlers.startHeaderClock();
    this.eventHandlers.setupPlaybackControl();
    this.eventHandlers.setupStatusPanel();
    this.eventHandlers.setupPizzIntIndicator();
    this.eventHandlers.setupExportPanel();
    this.eventHandlers.setupSearchControls();

    // Correlation engine is constructed lazily at its post-loadAllData run site
    // (Phase 6 below) so its bytes + adapters stay off the eager boot graph (#4486).
    this.eventHandlers.setupUnifiedSettings();
    // Phase 4: MapLayerHandlers, CountryIntel. SearchManager is lazy-loaded
    // on first CMD+K/search-button open so its modal catalog stays off startup.
    this.eventHandlers.setupMapLayerHandlers();
    await this.countryIntel.init();
    // Unblock any WebMCP tool invocations that arrived during startup.
    this.resolveUiReady();
    markLcpDebug('wm:boot:webmcp-ui-ready');

    // Phase 5: Event listeners + URL sync
    this.eventHandlers.init();
    // Capture deep link params BEFORE URL sync overwrites them
    const initState = parseMapUrlState(window.location.search, this.state.mapLayers);
    this.pendingDeepLinkCountry = initState.country ?? null;
    this.pendingDeepLinkExpanded = initState.expanded === true;
    this.pendingDeepLinkChokepoint = initState.chokepoint ?? null;
    const earlyParams = new URLSearchParams(window.location.search);
    this.pendingDeepLinkStoryCode = earlyParams.get('c') ?? null;
    this.pendingDeepLinkSearchQuery = readDashboardSearchQuery(window.location.search);
    this.pendingOrbitalShareLink = ORBITAL_WATCH_ENABLED ? takeOrbitalShareLink() : null;
    connectOrbitalLookupMap(() => this.state.map);
    this.eventHandlers.setupUrlStateSync();
    if (import.meta.env.VITE_E2E === '1') {
      document.documentElement.dataset.wmEventHandlersReady = 'true';
    }

    this.countryIntel.onBriefStateChange(({ visible }) => {
      // The loading panel opens with a placeholder code; the deep link stays
      // pending until a real country shows or the panel closes.
      const code = this.state.countryBriefPage?.getCode();
      if (!visible || (code && !code.startsWith('__'))) this.state.pendingCountryBrief = null;
      this.eventHandlers.syncUrlState();
    });

    // Start deep link handling early — its retry loop polls hasSufficientData()
    // independently, so it must not be gated behind loadAllData() which can hang.
    this.handleDeepLinks();

    // Phase 6: Data loading
    this.dataLoader.syncDataFreshnessWithLayers();
    const slowTierReady = this.waitForSlowBootstrapCheckpoint();
    if (this.state.isDestroyed) return;
    if (this.panelLayout.isWorldMode()) {
      // World first screen: no panel fan-out. Only news runs, so breaking
      // alerts reach the first screen's news row; the panel data phase starts
      // the first time "전체 보기" builds the full view.
      void this.dataLoader.loadNews().catch((e) => console.warn('[World] news load failed:', e));
      this.worldNewsTimer = window.setInterval(() => {
        void this.dataLoader.loadNews().catch(() => { /* next tick retries */ });
      }, WORLD_NEWS_REFRESH_MS);
      this.eventHandlers.setupSnapshotSaving();
      this.panelLayout.setFullViewStarter(() => {
        if (this.state.isDestroyed) return;
        if (this.worldNewsTimer !== null) window.clearInterval(this.worldNewsTimer);
        this.worldNewsTimer = null;
        this.state.breakingBanner ??= new BreakingNewsBanner();
        void this.runPanelDataPhase(slowTierReady, { snapshotSavingReady: true });
      });
      return;
    }
    await this.runPanelDataPhase(slowTierReady);
  }

  /** Phase 6-7 of init: panel data fan-out and refresh scheduling. */
  private async runPanelDataPhase(
    slowTierReady: Promise<boolean>,
    options: { snapshotSavingReady?: boolean } = {},
  ): Promise<void> {
    // forceAll=false at bootstrap: data-loader's existing per-panel
    // viewport gate (shouldLoad(id) = forceAll || isPanelNearViewport(id))
    // now actually fires, cutting the ~80-request fan-out down to the
    // panels currently above the fold. IntersectionObserver wiring in
    // panel-layout.ts plus handleViewportPrime above re-trigger
    // loadAllData() as below-fold panels enter the viewport. (#3990)
    // Slow-tier hydration keys are consume-once (getHydratedData deletes on
    // read) and the visible-data consumers in loadAllData read them at task
    // start. If the fan-out runs before the slow tier settles, those reads miss
    // and fall back to per-panel RPCs that never re-read the late payload —
    // wasting the ~500 KB slow-tier bootstrap. The shell LCP element already
    // painted back in panelLayout.init() (Phase 1), so awaiting here is OFF the
    // LCP critical path; it stays bounded by waitForBootstrapSlowTier's timeout
    // (3.5 s browser / 8.5 s desktop). (#4512)
    const settled = await slowTierReady;
    if (this.state.isDestroyed) return;
    // Snapshot whether precision geometry was already loaded BEFORE the fan-out
    // (the map renderer triggers the memoized fetch early). If so, the fan-out's
    // geometry-dependent CII ingests already attributed correctly and the
    // post-LCP replay would just be a redundant second CII compute + choropleth
    // repaint, so we skip it below. (#4512)
    const geometryReadyBeforeFanout = isCountryGeometryLoaded();
    if (!settled) {
      this.slowTierWaitTimedOut = true;
      // No fan-out mark here: the deferred runVisibleDataFanout() emits the paired
      // start/complete, and a second start would read as a phantom fan-out.
      await this.dataLoader.loadAllData();
    } else {
      await this.runVisibleDataFanout();
    }
    const countryGeometryReady = this.preloadCountryGeometryForPostLcpWork();

    // If bootstrap was served from cache but live data just loaded, promote the status indicator
    markBootstrapAsLive();
    this.bootstrapHydrationState = getBootstrapHydrationState();
    this.updateConnectivityUi();

    // Initial correlation engine run is post-LCP background work. Wait for
    // precision country geometry there instead of before visible data fan-out.
    this.startPostLcpIntelligence(countryGeometryReady, geometryReadyBeforeFanout);

    // Hide unconfigured layers after first data load
    if (!isAisConfigured()) {
      this.state.map?.hideLayerToggle('ais');
    }
    if (isOutagesConfigured() === false) {
      this.state.map?.hideLayerToggle('outages');
    }
    if (!CYBER_LAYER_ENABLED) {
      this.state.map?.hideLayerToggle('cyberThreats');
    }

    // Phase 7: Refresh scheduling
    this.setupRefreshIntervals();
    if (!options.snapshotSavingReady) this.eventHandlers.setupSnapshotSaving();
    cleanOldSnapshots().catch((e) => console.warn('[Storage] Snapshot cleanup failed:', e));

    // Phase 8: Update checks

    // Analytics
  }

  /**
   * Apply a late-arriving geolocation region without another network request
   * solely for geolocation (#7778). Updates prediction prioritization from the
   * kept candidate set using the same regional match rules; the failed-location
   * path keeps the synchronous fallback usable without a map jump. Never
   * late-recenters desktop. Guarded on isDestroyed so callbacks from a
   * destroyed (re-initialized) App cannot move the new map or its panels.
   */
  private applyLateGeoRegion(region: string): void {
    if (this.state.isDestroyed) return;
    if (!region || region === 'global') return;
    if (region === this.state.resolvedLocation) return;
    this.state.resolvedLocation = region as AppContext['resolvedLocation'];
    this.dataLoader.reprioritizeLateRegionPredictions(region);
  }

  private persistJsonStorageValue<T>(key: string, value: T): boolean {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (error) {
      if (isQuotaError(error)) markStorageQuotaExceeded();
      else console.warn(`Failed to save ${key} to storage:`, error);
      return false;
    }
  }

  /**
   * Re-enable map layers the retired free-tier gate turned off (recorded as
   * gate-owned). A `?layers=` deep link is a view, not a saved preference, so
   * an ephemeral snapshot is returned untouched.
   */
  private restoreGateOwnedMapLayers(
    layers: MapLayers,
    options: { ephemeralSnapshot?: boolean } = {},
  ): MapLayers {
    if (options.ephemeralSnapshot) return layers;
    const existingOwnership = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.mapLayerGateOwnership, []),
    );
    if (existingOwnership.size === 0) return layers;
    const restored = sanitizeLayersForVariant(
      restoreGateOwnedLockedLayers(layers, existingOwnership),
      SITE_VARIANT as MapVariant,
    );
    const unchanged = mapLayerStatesEqual(layers, restored);
    const persistence = persistGateOwnershipTransition(
      'pro',
      () => unchanged
        || this.persistJsonStorageValue(STORAGE_KEYS.mapLayers, restored),
      () => this.persistJsonStorageValue(STORAGE_KEYS.mapLayerGateOwnership, []),
    );
    return persistence.preferencePersisted ? restored : layers;
  }

  /** Put back the panels the retired free-tier gate hid (marked `proGated`). */
  private restoreProGatedPanelsForTier(): boolean {
    const panelSettings = loadFromStorage<Record<string, PanelConfig>>(STORAGE_KEYS.panels, {});
    const restored = restoreProGatedPanels(panelSettings);
    const changed = Object.keys(panelSettings).some((key) => (
      panelSettings[key]?.enabled !== restored[key]?.enabled
      || panelSettings[key]?.proGated !== restored[key]?.proGated
    ));
    if (!changed) return false;

    saveToStorage(STORAGE_KEYS.panels, restored);
    this.state.panelSettings = restored;
    this.panelLayout.applyPanelSettings();
    this.state.unifiedSettings?.refreshPanelToggles();
    return true;
  }

  private currentSourceCapLanguage(): string {
    let explicitLocale = '';
    try { explicitLocale = localStorage.getItem('wm-locale-explicit') || ''; } catch { /* private mode */ }
    return ((explicitLocale || navigator.language || 'en').split('-')[0] ?? 'en').toLowerCase();
  }

  private sourceCapProtectedNames(userLang: string): Set<string> {
    const protectedNames = new Set<string>(FREE_CAP_PROTECTED_SOURCES);
    for (const name of getStrategicDefaultSources()) protectedNames.add(name);
    if (userLang !== 'en') {
      for (const name of getLocaleBoostedSources(userLang)) protectedNames.add(name);
    }
    return protectedNames;
  }

  /** Restore the sources the retired 80-source cap disabled, keeping user choices. */
  private reconcileSourceLimitForTier(): boolean {
    let ownershipMetadataExists = false;
    try {
      ownershipMetadataExists = localStorage.getItem(STORAGE_KEYS.sourceGateOwnership) !== null;
    } catch { /* optional persistence */ }
    const persistedDisabled = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []),
    );
    const persistedGateOwned = new Set(
      loadFromStorage<string[]>(STORAGE_KEYS.sourceGateOwnership, []),
    );
    let gateOwned = new Set(persistedGateOwned);
    const userLang = this.currentSourceCapLanguage();
    const protectedNames = this.sourceCapProtectedNames(userLang);

    // Heal untouched profiles capped before ownership metadata existed. Exact
    // matching preserves every customized denylist.
    if (!ownershipMetadataExists) {
      const defaultUserDisabled = new Set(computeDefaultDisabledSources(userLang));
      const expectedGateOwned = selectSourcesUnderCap(
        FEEDS,
        INTEL_SOURCES,
        defaultUserDisabled,
        LEGACY_FREE_MAX_SOURCES,
        protectedNames,
      ).autoDisabled;
      gateOwned = inferExactSourceGateOwnership(
        persistedDisabled,
        defaultUserDisabled,
        expectedGateOwned,
      ) ?? gateOwned;
    }

    const nextDisabled = restoreGateOwnedSources(persistedDisabled, gateOwned);
    const nextGateOwned = new Set<string>();

    const disabledChanged = !stringSetsEqual(persistedDisabled, nextDisabled);
    const ownershipChanged = !ownershipMetadataExists
      || !stringSetsEqual(persistedGateOwned, nextGateOwned);
    const persistence = persistGateOwnershipTransition(
      'pro',
      () => !disabledChanged
        || this.persistJsonStorageValue(STORAGE_KEYS.disabledFeeds, [...nextDisabled]),
      () => !ownershipChanged
        || this.persistJsonStorageValue(
          STORAGE_KEYS.sourceGateOwnership,
          [...nextGateOwned],
        ),
    );
    const disabledPersisted = disabledChanged && persistence.preferencePersisted;
    const ownershipPersisted = ownershipChanged && persistence.ownershipPersisted;
    if (disabledChanged) {
      this.state.disabledSources = new Set(nextDisabled);
    }
    if (disabledPersisted || ownershipPersisted) {
      console.log(`[App] restored ${gateOwned.size} source(s) disabled by the retired free-tier gate`);
    }
    return disabledPersisted || ownershipPersisted;
  }

  /**
   * Undo what the retired free-tier gate left in storage: panels it hid and
   * sources it auto-disabled. Safe to call multiple times (idempotent).
   */
  private restoreGateOwnedPreferences(): boolean {
    // ── One-time v1 cap-bug recovery ──────────────────────────────────
    // Pre-2026-05-01 the source cap was enforced by Array.sort().slice(),
    // which silently auto-disabled every source past alphabetical position
    // LEGACY_FREE_MAX_SOURCES — catastrophically erasing late-alphabet categories
    // (Layoffs and Semiconductors). Storage
    // didn't track auto-disabled vs user-disabled, so a heuristic that runs
    // on every load would silently undo a user who legitimately disabled
    // every source in a category — and re-undo it on every refresh forever.
    //
    // Migration approach: run findFullyDisabledCategories ONCE, gated by
    // disabledFeedsSchema version. After the migration completes, bump
    // schema → 1 so subsequent loads skip recovery entirely. Users who
    // explicitly toggle off every source in a category post-migration
    // keep that preference permanently. Trade-off: a user who BEFORE the
    // migration legitimately disabled every source in a category will lose
    // those preferences once. That's acceptable since v1 victims have been
    // suffering silent breakage and the explicit-full-category-disable
    // pattern is rare (users typically hide the whole panel instead).
    const schemaVersion = loadFromStorage<number>(STORAGE_KEYS.disabledFeedsSchema, 0);
    if (schemaVersion < 1) {
      const disabled = new Set(loadFromStorage<string[]>(STORAGE_KEYS.disabledFeeds, []));
      const recoverable = findFullyDisabledCategories(FEEDS, disabled);
      if (recoverable.length > 0) {
        for (const name of recoverable) disabled.delete(name);
        saveToStorage(STORAGE_KEYS.disabledFeeds, Array.from(disabled));
        console.log(`[App] One-time v1-cap-bug migration: re-enabled ${recoverable.length} source(s) from fully-disabled categories. This will not run again.`);
      }
      saveToStorage(STORAGE_KEYS.disabledFeedsSchema, 1);
    }

    const panelsChanged = this.restoreProGatedPanelsForTier();
    this.reconcileSourceLimitForTier();
    return panelsChanged;
  }

  public destroy(): void {
    // Invalidate optional local-AI continuations FIRST: any detached
    // mlWorker.whenReady() callback captured below terminates instead of
    // downloading models or restarting for a destroyed app (#7779).
    this.localAiInitEpoch += 1;
    this.state.isDestroyed = true;
    this.latestSearchAdsb = [];
    this.latestSearchMilitary = [];
    this.latestSearchAdsbUpdatedAt = 0;
    this.autoGeoRecenterApplied = false;
    this.resolveAppDestroyed();
    // Cancel in-flight App-owned waits before DOM teardown can mutate the
    // document and wake a waiter that still closes over this instance.
    this.lifecycleController.abort();
    // Unregister agent entry points before the rest of teardown. In particular,
    // init-failure cleanup may run on a partially initialised App; even if a
    // later module cleanup throws, no WebMCP tool may retain this dead instance.
    this.webMcpController?.abort();
    this.webMcpController = null;
    this.viewportHydrationReady = false;
    this.viewportHydrationReadyAt = 0;
    this.viewportTriggersArmed = false;
    this.slowTierWaitTimedOut = false;
    cancelBootstrapSlowTier();
    window.removeEventListener('scroll', this.handleViewportPrime, { capture: true });
    window.removeEventListener('resize', this.handleViewportPrime);
    window.removeEventListener('online', this.handleConnectivityChange);
    window.removeEventListener('offline', this.handleConnectivityChange);
    window.removeEventListener(I18N_RESOURCES_LOADED_EVENT, this.handleI18nResourcesLoaded);
    if (this.visiblePanelPrimeRaf !== null) {
      window.cancelAnimationFrame(this.visiblePanelPrimeRaf);
      this.visiblePanelPrimeRaf = null;
    }
    this.cancelOrbitalShareLink?.();
    this.cancelOrbitalShareLink = null;
    if (this.chokepointDeepLinkTimer !== null) {
      window.clearTimeout(this.chokepointDeepLinkTimer);
      this.chokepointDeepLinkTimer = null;
    }
    if (this.stockDeepLinkTimer !== null) {
      window.clearTimeout(this.stockDeepLinkTimer);
      this.stockDeepLinkTimer = null;
    }

    try {
      // Destroy all modules in reverse order. A single destructor must not skip
      // remaining modules or the map/AIS tail cleanup.
      for (let i = this.modules.length - 1; i >= 0; i--) {
        try {
          this.modules[i]!.destroy();
        } catch {
          // Continue tearing down the rest of the dashboard.
        }
      }
    } finally {
      // Clean up subscriptions, map, AIS, and breaking news
      this.unsubAiFlow?.();
      mlWorker.terminate();
      this.state.findingsBadge?.destroy();
      this.state.findingsBadge = null;
      this.state.breakingBanner?.destroy();
      if (this.worldNewsTimer !== null) window.clearInterval(this.worldNewsTimer);
      this.worldNewsTimer = null;
      destroyBreakingNewsAlerts();
      this.cachedModeBannerEl?.remove();
      this.cachedModeBannerEl = null;
      this.state.map?.destroy();
      disconnectAisStream();
      stopFlightHistoryCleanup();
      stopLoadedVesselHistoryCleanup();
    }
  }

  private async initFindingsBadge(): Promise<void> {
    try {
      const { IntelligenceGapBadge } = await import('@/components/IntelligenceGapBadge');
      if (this.state.isDestroyed) return;
      this.state.findingsBadge = new IntelligenceGapBadge();
      this.state.findingsBadge.setOnSignalClick((signal) => {
        if (this.state.countryBriefPage?.isVisible()) return;
        if (safeStorageGet('wm-settings-open') === '1') return;
        void this.state.ensureSignalModal()
          .then((signalModal) => {
            if (!this.state.isDestroyed) signalModal.showSignal(signal);
          })
          .catch((err) => {
            console.warn('[SignalModal] Failed to show signal:', err);
          });
      });
      this.state.findingsBadge.setOnAlertClick((alert) => {
        if (this.state.countryBriefPage?.isVisible()) return;
        if (safeStorageGet('wm-settings-open') === '1') return;
        void this.state.ensureSignalModal()
          .then((signalModal) => {
            if (!this.state.isDestroyed) signalModal.showAlert(alert);
          })
          .catch((err) => {
            console.warn('[SignalModal] Failed to show alert:', err);
          });
      });
    } catch (error) {
      console.warn('[IntelligenceGapBadge] Lazy init failed:', error);
    }
  }

  // Waits for Phase-4 UI modules to finish initialising. WebMCP bindings call
  // this before touching nullable UI
  // state so a tool invoked during startup waits rather than throwing;
  // the timeout guards against a genuinely broken init path hanging the
  // agent forever.
  private async waitForUiReady(
    signal?: AbortSignal,
    timeoutMs = WEBMCP_UI_READY_TIMEOUT_MS,
  ): Promise<void> {
    await waitForWebMcpUiReady(this.uiReady, this.appDestroyed, timeoutMs, 'UI', signal);
  }

  private async waitForDashboardReady(
    requireMapRenderer = true,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      await this.waitForUiReady(signal);
      if (!requireMapRenderer) return;
      const map = this.state.map;
      if (map) {
        await waitForWebMcpUiReady(
          map.whenRendererReady(),
          this.appDestroyed,
          15_000,
          'Map renderer',
          signal,
        );
      }
    } catch (error) {
      throwIfWebMcpAborted(signal);
      // A dashboard binding that loses the readiness/destroy race must reach
      // the narrow context/applier seam so it can return its closed
      // app_destroyed reason. Genuine readiness timeouts still reject.
      if (!this.state.isDestroyed) throw error;
    }
  }

  private handleDeepLinks(): void {
    const url = new URL(window.location.href);
    const DEEP_LINK_INITIAL_DELAY_MS = 1500;

    // A satellite pass share link lives in the fragment and opens beside any other deep link.
    const orbitalShareLink = this.pendingOrbitalShareLink;
    this.pendingOrbitalShareLink = null;
    if (orbitalShareLink) {
      this.cancelOrbitalShareLink = scheduleOrbitalShareLink(orbitalShareLink, DEEP_LINK_INITIAL_DELAY_MS, () => this.state.isDestroyed, () => this.state.map);
    }

    // SearchAction lands on /dashboard?q=… after URL sync has already rewritten
    // the address bar. Consume the captured term through the same lazy path as
    // Cmd+K so the modal is created only when a query is actually present.
    const searchQuery = this.pendingDeepLinkSearchQuery;
    this.pendingDeepLinkSearchQuery = null;
    if (
      searchQuery
      && (url.pathname === '/dashboard' || url.pathname === '/dashboard/')
    ) {
      void this.openSearch({ initialQuery: searchQuery });
      return;
    }

    // Check for country brief deep link: ?c=IR (captured early before URL sync)
    const storyCode = this.pendingDeepLinkStoryCode ?? url.searchParams.get('c');
    this.pendingDeepLinkStoryCode = null;
    if (isStockResearchPath(url.pathname)) {
      const stockSymbol = stockResearchSymbolFromPath(url.pathname);
      // Return only when the overlay actually takes the navigation. The path
      // regex accepts a leading digit that the symbol pattern rejects, so
      // /stocks/0700.HK parses to null — returning there would open nothing
      // AND cancel the ?c= / ?country= / ?chokepoint= deep links below.
      if (stockSymbol) {
        this.stockDeepLinkTimer = window.setTimeout(() => {
          this.stockDeepLinkTimer = null;
          if (this.state.isDestroyed) return;
          void openStockResearchOverlay(stockSymbol);
        }, DEEP_LINK_INITIAL_DELAY_MS);
        return;
      }
    }

    if (url.pathname === '/story' || storyCode) {
      const countryCode = storyCode;
      if (countryCode) {
        const countryName = getCountryNameByCode(countryCode.toUpperCase()) || countryCode;
        setTimeout(() => {
          void this.countryIntel.openCountryBriefByCode(countryCode.toUpperCase(), countryName, {
            maximize: true,
          }).catch((err) => {
            console.error('[CountryBrief] Failed to open country brief:', err);
            showToast('Country brief failed to open. Please try again.');
          });
          this.eventHandlers.syncUrlState();
        }, DEEP_LINK_INITIAL_DELAY_MS);
        return;
      }
    }

    // Check for country brief deep link: ?country=UA or ?country=UA&expanded=1
    const deepLinkCountry = this.pendingDeepLinkCountry;
    const deepLinkExpanded = this.pendingDeepLinkExpanded;
    this.pendingDeepLinkCountry = null;
    this.pendingDeepLinkExpanded = false;
    if (deepLinkCountry) {
      const cName = CountryIntelManager.resolveCountryName(deepLinkCountry);
      // Set in the same task as setupUrlStateSync(), before its first debounced
      // write, and only here: search and story links return above and open no
      // ?country brief.
      this.state.pendingCountryBrief = { code: deepLinkCountry, expanded: deepLinkExpanded };
      setTimeout(() => {
        void this.countryIntel.openCountryBriefByCode(deepLinkCountry, cName, {
          maximize: deepLinkExpanded,
        }).catch((err) => {
          console.error('[CountryBrief] Failed to open country brief:', err);
          showToast('Country brief failed to open. Please try again.');
        }).finally(() => {
          // The open also resolves without a brief (a failed chunk import is
          // handled inside it, a stale request returns). Once it settles the
          // panel itself decides the URL.
          this.state.pendingCountryBrief = null;
          this.eventHandlers.syncUrlState();
        });
        this.eventHandlers.syncUrlState();
      }, DEEP_LINK_INITIAL_DELAY_MS);
    }

    // Check for chokepoint deep link: ?chokepoint=bab_el_mandeb — pans the map to
    // the waterway and opens its popup (the chokepoint equivalent of the country
    // brief deep link). openChokepoint no-ops on an unknown id.
    const deepLinkChokepoint = this.pendingDeepLinkChokepoint;
    this.pendingDeepLinkChokepoint = null;
    if (deepLinkChokepoint) {
      this.state.activeChokepoint = deepLinkChokepoint;
      this.chokepointDeepLinkTimer = window.setTimeout(() => {
        this.chokepointDeepLinkTimer = null;
        if (this.state.isDestroyed) return;
        this.state.mapLayers.waterways = true;
        this.state.map?.enableLayer('waterways');
        this.state.map?.openChokepoint(deepLinkChokepoint);
        this.eventHandlers.syncUrlState();
      }, DEEP_LINK_INITIAL_DELAY_MS);
    }
  }

  private setupRefreshIntervals(): void {
    // Always refresh news for all variants
    this.refreshScheduler.scheduleRefresh('news', () => this.dataLoader.loadNews(), REFRESH_INTERVALS.feeds);
    // Registration (and its immediate first hydration) is deferred to
    // post-paint idle: freshness badges are below-the-fold decoration, so the
    // fetch must not compete with the LCP-window requests (#4907, #4890).
    scheduleAfterFirstPaint(() => {
      this.refreshScheduler.scheduleRefresh(
        'health-freshness',
        async () => { await refreshDataFreshnessFromHealth(); },
        REFRESH_INTERVALS.healthFreshness,
        undefined,
        { runImmediately: true },
      );
    });

    this.refreshScheduler.scheduleRefresh(
      'ukmtoIncidents',
      () => this.dataLoader.loadUkmtoIncidents(),
      60_000,
      () => (SITE_VARIANT === 'full' && this.state.mapLayers.ais) || this.state.panelSettings['ukmto-incidents']?.enabled === true,
    );

    this.refreshScheduler.scheduleRefresh(
      'reservoirLevels',
      () => this.dataLoader.loadReservoirLevels(),
      REFRESH_INTERVALS.reservoirLevels,
      () => this.state.mapLayers.reservoirLevels === true || this.state.panelSettings['reservoir-levels']?.enabled === true,
    );

    {
      this.refreshScheduler.registerAll([
        {
          name: 'markets',
          fn: () => this.dataLoader.loadMarkets(),
          intervalMs: REFRESH_INTERVALS.markets,
          condition: () => this.isAnyPanelNearViewport(['markets', 'heatmap', 'commodities']),
        },
        {
          name: 'predictions',
          fn: () => this.dataLoader.loadPredictions(),
          intervalMs: REFRESH_INTERVALS.predictions,
          condition: () => this.isPanelNearViewport('polymarket'),
        },
        {
          name: 'forecasts',
          fn: () => this.dataLoader.loadForecasts(),
          intervalMs: REFRESH_INTERVALS.forecasts,
          condition: () => this.isPanelNearViewport('forecast'),
        },
        { name: 'pizzint', fn: () => this.dataLoader.loadPizzInt(), intervalMs: REFRESH_INTERVALS.pizzint, condition: () => SITE_VARIANT === 'full' },
        { name: 'natural', fn: () => this.dataLoader.loadNatural(), intervalMs: REFRESH_INTERVALS.natural, condition: () => this.state.mapLayers.natural },
        { name: 'weather', fn: () => this.dataLoader.loadWeatherAlerts(), intervalMs: REFRESH_INTERVALS.weather, condition: () => this.state.mapLayers.weather },
        { name: 'pipelineRegistries', fn: () => this.dataLoader.loadPipelineRegistries({ refresh: true }), intervalMs: REFRESH_INTERVALS.pipelineStatus, condition: () => !!this.state.mapLayers.pipelines },
        { name: 'storageFacilities', fn: () => this.dataLoader.loadStorageFacilities({ refresh: true }), intervalMs: REFRESH_INTERVALS.storageFacilityMap, condition: () => !!this.state.mapLayers.storageFacilities },
        { name: 'fred', fn: () => this.dataLoader.loadFredData(), intervalMs: REFRESH_INTERVALS.fred, condition: () => this.isPanelNearViewport('economic') },
        { name: 'spending', fn: () => this.dataLoader.loadGovernmentSpending(), intervalMs: REFRESH_INTERVALS.spending, condition: () => this.isPanelNearViewport('economic') },
        { name: 'global-tenders', fn: () => this.dataLoader.loadGlobalTenders(), intervalMs: REFRESH_INTERVALS.spending, condition: () => this.isPanelNearViewport('global-procurement') },
        { name: 'bis', fn: () => this.dataLoader.loadBisData(), intervalMs: REFRESH_INTERVALS.bis, condition: () => this.isPanelNearViewport('economic') },
        { name: 'oil', fn: () => this.dataLoader.loadOilAnalytics(), intervalMs: REFRESH_INTERVALS.oil, condition: () => this.isPanelNearViewport('energy-complex') },
        // inFlight key 'fires' matches the hydration loader and loadDataForLayer
        // (the map-layer key), like every other layer refresh here — so all three
        // firms call sites one-flight the guard-less loadFirmsData (#6770).
        { name: 'fires', fn: () => this.dataLoader.loadFirmsData(), intervalMs: REFRESH_INTERVALS.firms, condition: () => this.shouldRefreshFirms() },
        { name: 'ais', fn: () => this.dataLoader.loadAisSignals(), intervalMs: REFRESH_INTERVALS.ais, condition: () => this.state.mapLayers.ais },
        { name: 'cables', fn: () => this.dataLoader.loadCableActivity(), intervalMs: REFRESH_INTERVALS.cables, condition: () => this.state.mapLayers.cables },
        { name: 'cableHealth', fn: () => this.dataLoader.loadCableHealth(), intervalMs: REFRESH_INTERVALS.cableHealth, condition: () => this.state.mapLayers.cables },
        { name: 'flights', fn: () => this.dataLoader.loadFlightDelays(), intervalMs: REFRESH_INTERVALS.flights, condition: () => this.state.mapLayers.flights },
        {
          name: 'cyberThreats', fn: () => {
            this.state.cyberThreatsCache = null;
            return this.dataLoader.loadCyberThreats();
          }, intervalMs: REFRESH_INTERVALS.cyberThreats, condition: () => CYBER_LAYER_ENABLED && this.state.mapLayers.cyberThreats
        },
      ]);
    }

    if (SITE_VARIANT === 'finance') {
      this.refreshScheduler.scheduleRefresh(
        'daily-market-brief',
        () => this.dataLoader.loadDailyMarketBrief(),
        REFRESH_INTERVALS.dailyMarketBrief,
        () => this.isPanelNearViewport('daily-market-brief'),
      );
      this.refreshScheduler.scheduleRefresh(
        'market-implications',
        () => this.dataLoader.loadMarketImplications(),
        REFRESH_INTERVALS.marketImplications,
        () => this.isPanelNearViewport('market-implications'),
      );
    }

    // Panel-level refreshes (moved from panel constructors into scheduler for hidden-tab awareness + jitter)
    this.refreshScheduler.scheduleRefresh(
      'service-status',
      () => (this.state.panels['service-status'] as ServiceStatusPanel).fetchStatus(),
      REFRESH_INTERVALS.serviceStatus,
      () => this.isPanelNearViewport('service-status')
    );
    this.refreshScheduler.scheduleRefresh(
      'energy-crisis',
      () => (this.state.panels['energy-crisis'] as EnergyCrisisPanel).fetchData(),
      REFRESH_INTERVALS.energyCrisis,
      () => this.isPanelNearViewport('energy-crisis')
    );
    this.refreshScheduler.scheduleRefresh(
      'macro-signals',
      () => (this.state.panels['macro-signals'] as MacroSignalsPanel).fetchData(),
      REFRESH_INTERVALS.macroSignals,
      () => this.isPanelNearViewport('macro-signals')
    );
    this.refreshScheduler.scheduleRefresh(
      'fear-greed',
      () => (this.state.panels['fear-greed'] as FearGreedPanel).fetchData(),
      REFRESH_INTERVALS.fearGreed,
      () => this.isPanelNearViewport('fear-greed')
    );
    this.refreshScheduler.scheduleRefresh(
      'hormuz-tracker',
      () => (this.state.panels['hormuz-tracker'] as HormuzPanel).fetchData(),
      REFRESH_INTERVALS.hormuzTracker,
      () => this.isPanelNearViewport('hormuz-tracker')
    );
    this.refreshScheduler.scheduleRefresh(
      'positioning-247',
      () => (this.state.panels['positioning-247'] as PositioningPanel).fetchData(),
      REFRESH_INTERVALS.hyperliquidFlow,
      () => this.isPanelNearViewport('positioning-247')
    );
    this.refreshScheduler.scheduleRefresh(
      'strategic-posture',
      () => (this.state.panels['strategic-posture'] as StrategicPosturePanel).refresh(),
      REFRESH_INTERVALS.strategicPosture,
      () => this.isPanelNearViewport('strategic-posture')
    );
    this.refreshScheduler.scheduleRefresh(
      'strategic-risk',
      () => (this.state.panels['strategic-risk'] as StrategicRiskPanel).refresh(),
      REFRESH_INTERVALS.strategicRisk,
      () => this.isPanelNearViewport('strategic-risk')
    );

    // Server-side temporal anomalies (news + satellite_fires)
    {
      this.refreshScheduler.scheduleRefresh('temporalBaseline', () => this.dataLoader.refreshTemporalBaseline(), REFRESH_INTERVALS.temporalBaseline, () => this.shouldRefreshIntelligence());
    }

    // WTO trade policy data — annual data, poll every 10 min to avoid hammering upstream.
    // PRO-gated: the isNearViewport check is a visibility gate, not an entitlement gate,
    // so without hasPremiumAccess() here we'd still hit the 6 WTO RPCs every poll for
    // free users once the panel scrolled into view.
    // Not variant-gated: a user can add these panels to any variant, and each
    // condition already requires the panel on screen (#9396).
    this.refreshScheduler.scheduleRefresh('tradePolicy', () => this.dataLoader.loadTradePolicy(), REFRESH_INTERVALS.tradePolicy, () => this.isPanelNearViewport('trade-policy'));
    this.refreshScheduler.scheduleRefresh('supplyChain', () => this.dataLoader.loadSupplyChain(), REFRESH_INTERVALS.supplyChain, () => this.isPanelNearViewport('supply-chain'));
    this.refreshScheduler.scheduleRefresh('chinaCorridors', () => this.dataLoader.loadChinaCorridors(), REFRESH_INTERVALS.chinaCorridors, () => this.isPanelNearViewport('china-corridors'));
    this.refreshScheduler.scheduleRefresh('chinaActivityNowcast', () => this.dataLoader.loadChinaActivityNowcast(), REFRESH_INTERVALS.chinaActivityNowcast, () => this.isPanelNearViewport('china-activity-nowcast'));

    this.refreshScheduler.scheduleRefresh(
      'cross-source-signals',
      () => this.dataLoader.loadCrossSourceSignals(),
      REFRESH_INTERVALS.crossSourceSignals,
      () => this.isPanelNearViewport('cross-source-signals'),
    );

    this.refreshScheduler.scheduleRefresh(
      'gulf-economies',
      () => (this.state.panels['gulf-economies'] as GulfEconomiesPanel).fetchData(),
      REFRESH_INTERVALS.gulfEconomies,
      () => this.isPanelNearViewport('gulf-economies')
    );

    this.refreshScheduler.scheduleRefresh(
      'grocery-basket',
      () => (this.state.panels['grocery-basket'] as GroceryBasketPanel).fetchData(),
      REFRESH_INTERVALS.groceryBasket,
      () => this.isPanelNearViewport('grocery-basket')
    );

    this.refreshScheduler.scheduleRefresh(
      'fuel-prices',
      () => (this.state.panels['fuel-prices'] as FuelPricesPanel).fetchData(),
      REFRESH_INTERVALS.fuelPrices,
      () => this.isPanelNearViewport('fuel-prices')
    );

    this.refreshScheduler.scheduleRefresh(
      'fx',
      () => (this.state.panels['fx'] as FxPanel).fetchData(),
      REFRESH_INTERVALS.fx,
      () => this.isPanelNearViewport('fx')
    );

    this.refreshScheduler.scheduleRefresh(
      'fao-food-price-index',
      () => (this.state.panels['fao-food-price-index'] as FaoFoodPriceIndexPanel).fetchData(),
      REFRESH_INTERVALS.faoFoodPriceIndex,
      () => this.isPanelNearViewport('fao-food-price-index')
    );

    this.refreshScheduler.scheduleRefresh(
      'oil-inventories',
      () => (this.state.panels['oil-inventories'] as OilInventoriesPanel).fetchData(),
      REFRESH_INTERVALS.oilInventories,
      () => this.isPanelNearViewport('oil-inventories')
    );

    this.refreshScheduler.scheduleRefresh(
      'pipeline-status',
      () => (this.state.panels['pipeline-status'] as PipelineStatusPanel).fetchData(),
      REFRESH_INTERVALS.pipelineStatus,
      () => this.isPanelNearViewport('pipeline-status')
    );

    this.refreshScheduler.scheduleRefresh(
      'storage-facility-map',
      () => (this.state.panels['storage-facility-map'] as StorageFacilityMapPanel).fetchData(),
      REFRESH_INTERVALS.storageFacilityMap,
      () => this.isPanelNearViewport('storage-facility-map')
    );

    this.refreshScheduler.scheduleRefresh(
      'fuel-shortages',
      () => (this.state.panels['fuel-shortages'] as FuelShortagePanel).fetchData(),
      REFRESH_INTERVALS.fuelShortages,
      () => this.isPanelNearViewport('fuel-shortages')
    );

    this.refreshScheduler.scheduleRefresh(
      'energy-disruptions',
      () => (this.state.panels['energy-disruptions'] as EnergyDisruptionsPanel).fetchData(),
      REFRESH_INTERVALS.energyDisruptions,
      () => this.isPanelNearViewport('energy-disruptions')
    );

    this.refreshScheduler.scheduleRefresh(
      'energy-risk-overview',
      () => (this.state.panels['energy-risk-overview'] as EnergyRiskOverviewPanel).fetchData(),
      REFRESH_INTERVALS.energyRiskOverview,
      () => this.isPanelNearViewport('energy-risk-overview')
    );

    this.refreshScheduler.scheduleRefresh(
      'grid-disruption-clock',
      () => (this.state.panels['grid-disruption-clock'] as GridDisruptionClockPanel).fetchData(),
      REFRESH_INTERVALS.gridDisruptionClock,
      () => this.isPanelNearViewport('grid-disruption-clock'),
    );

    this.refreshScheduler.scheduleRefresh(
      'chokepoint-strip',
      () => (this.state.panels['chokepoint-strip'] as ChokepointStripPanel).fetchData(),
      REFRESH_INTERVALS.chokepointStrip,
      () => this.isPanelNearViewport('chokepoint-strip')
    );

    this.refreshScheduler.scheduleRefresh(
      'climate-news',
      () => (this.state.panels['climate-news'] as ClimateNewsPanel).fetchData(),
      REFRESH_INTERVALS.climateNews,
      () => this.isPanelNearViewport('climate-news')
    );

    this.refreshScheduler.scheduleRefresh(
      'macro-tiles',
      () => (this.state.panels['macro-tiles'] as MacroTilesPanel).fetchData(),
      REFRESH_INTERVALS.macroTiles,
      () => this.isPanelNearViewport('macro-tiles')
    );
    this.refreshScheduler.scheduleRefresh(
      'fsi',
      () => (this.state.panels['fsi'] as FSIPanel).fetchData(),
      REFRESH_INTERVALS.fsi,
      () => this.isPanelNearViewport('fsi')
    );
    this.refreshScheduler.scheduleRefresh(
      'yield-curve',
      () => (this.state.panels['yield-curve'] as YieldCurvePanel).fetchData(),
      REFRESH_INTERVALS.yieldCurve,
      () => this.isPanelNearViewport('yield-curve')
    );
    this.refreshScheduler.scheduleRefresh(
      'economic-calendar',
      () => (this.state.panels['economic-calendar'] as EconomicCalendarPanel).fetchData(),
      REFRESH_INTERVALS.economicCalendar,
      () => this.isPanelNearViewport('economic-calendar')
    );
    this.refreshScheduler.scheduleRefresh(
      'cot-positioning',
      () => (this.state.panels['cot-positioning'] as CotPositioningPanel).fetchData(),
      REFRESH_INTERVALS.cotPositioning,
      () => this.isPanelNearViewport('cot-positioning')
    );
    this.refreshScheduler.scheduleRefresh(
      'gold-intelligence',
      () => (this.state.panels['gold-intelligence'] as GoldIntelligencePanel).fetchData(),
      REFRESH_INTERVALS.goldIntelligence,
      () => this.isPanelNearViewport('gold-intelligence')
    );
    this.refreshScheduler.scheduleRefresh(
      'market-breadth',
      () => this.dataLoader.loadMarketBreadth(),
      REFRESH_INTERVALS.marketBreadth,
      () => this.isPanelNearViewport('market-breadth')
    );
    this.refreshScheduler.scheduleRefresh(
      'news-market-correlation',
      () => (this.state.panels['news-market-correlation'] as NewsMarketCorrelationPanel).fetchData(),
      REFRESH_INTERVALS.newsMarketCorrelation,
      () => this.isPanelNearViewport('news-market-correlation')
    );

    // Refresh intelligence signals for CII (geopolitical variant only)
    if (SITE_VARIANT === 'full') {
      this.refreshScheduler.scheduleRefresh('intelligence', () => {
        const { military, iranEvents } = this.state.intelligenceCache;
        this.state.intelligenceCache = {};
        if (military) this.state.intelligenceCache.military = military;
        if (iranEvents) this.state.intelligenceCache.iranEvents = iranEvents;
        return this.dataLoader.loadIntelligenceSignals();
      }, REFRESH_INTERVALS.intelligence, () => this.shouldRefreshIntelligence());
    } else {
      // Other variants have no intelligence refresh, so Internet Disruptions
      // gets its own. Drop the cached outages so loadOutages refetches.
      this.refreshScheduler.scheduleRefresh('internet-disruptions', () => {
        delete this.state.intelligenceCache.outages;
        return this.dataLoader.loadOutages();
      }, REFRESH_INTERVALS.intelligence, () => this.isPanelNearViewport('internet-disruptions'));
    }

    // Correlation engine refresh
    this.refreshScheduler.scheduleRefresh(
      'correlation-engine',
      async () => {
        await this.runCorrelationEngine();
      },
      REFRESH_INTERVALS.correlationEngine,
      () => this.shouldRefreshCorrelation(),
    );
  }
}
