import type { AppContext } from '@/app/app-context';
import { WorldMasthead, WorldDispatchBar, WorldKeyPlate, WorldZoomControls, WorldBottomShelf, WorldStatusBanner } from '@/components/world/WorldChrome';
import { WorldCountryDrawer } from '@/components/world/WorldCountryDrawer';
import { renderCoordAxes } from '@/components/world/WorldCoordAxes';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { loadWorldOverview, setWorldMark } from '@/services/world-overview';
import { buildCountryDrawerData, buildWorldMapView } from '@/services/world-overview-view';
import { buildSupplementalTickerItems, loadTickerItems } from '@/services/world-ticker';
import { loadFundingStress } from '@/services/funding-stress';
import type { FundingStress } from '@/services/funding-stress';
import { loadIodaOutages } from '@/services/internet-outages-ioda';
import type { IodaOutage } from '@/services/internet-outages-ioda';
import { loadEuGasFlows } from '@/services/eu-gas-flows';
import type { EuGasFlows } from '@/services/eu-gas-flows';
import { getWorldFields, setWorldFields } from '@/services/world-first-screen-prefs';
import { getCurrentTheme, setTheme } from '@/utils/theme-manager';
import { kstDate } from '../../shared/world-overview.js';
import type { CountryDrawerData, WorldField, WorldMapView, WorldMarkRequest } from '@/types/world-overview';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import { WorldClockStrip, WorldEventLog, WorldOpsCounters, WorldThreatBadge } from '@/components/world/WorldOps';
import { buildOpsEvents, computeOpsMetrics } from '@/services/world-ops';
import type { OpsCounters } from '@/types/world-overview';
import { WORLD_FIELDS } from '../../shared/world-overview.js';
import { loadKrEcosMacro } from '@/services/kr-ecos';
import type { KrEcosMacro } from '@/services/kr-ecos';
import { loadKrCustomsTrade } from '@/services/kr-customs-trade';
import type { KrCustomsTrade } from '@/services/kr-customs-trade';
import { loadKrDartDisclosures } from '@/services/kr-dart';
import type { KrDartDisclosure } from '@/services/kr-dart';

export interface WorldFirstScreenSlots {
  root: HTMLElement;
  masthead: HTMLElement;
  /** Ops room row 2 (clocks + counters); 26px in the dark theme, collapsed in the light theme until styled. */
  telemetry: HTMLElement;
  dispatch: HTMLElement;
  stage: HTMLElement;
  shelf: HTMLElement;
}

type WorldSnapshot = NonNullable<Awaited<ReturnType<typeof loadWorldOverview>>['snapshot']>;
const RELOAD_AFTER_MS = 10 * 60 * 1000;
const TICKER_REFRESH_MS = 5 * 60 * 1000;

export function mountWorldFirstScreen(
  ctx: AppContext,
  slots: WorldFirstScreenSlots,
  hooks: { openFullView(): void; openCountryBrief(iso2: string): void },
): { destroy(): void; onEnter(): void; onLeave(): void } {
  if (!ctx.map) throw new Error('MapContainer must exist before mounting the world first screen');
  const map = ctx.map!;
  let fields = getWorldFields();
  let snapshot: WorldSnapshot | null = null;
  let currentView: WorldMapView | null = null;
  let selectedIso2: string | null = null;
  let lastLoadedAt = 0;
  let loadGeneration = 0;
  let destroyed = false;
  let fundingStress: FundingStress | null = null;
  let outages: IodaOutage[] = [];
  let gasFlows: EuGasFlows | null = null;
  let krEcos: KrEcosMacro | null = null;
  let krTrade: KrCustomsTrade | null = null;
  let krDisclosures: KrDartDisclosure[] = [];
  let extrasLoadedAt = 0;
  let extrasLoading = false;
  let extrasTimer: ReturnType<typeof setInterval> | null = null;
  let worldShown = true;
  const breakingAlerts: BreakingAlert[] = [];

  slots.root.classList.add('wfs-root');
  map.setWorldOverviewMode(true);

  const masthead = new WorldMasthead({
    onToggleTheme: () => setTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark'),
    onOpenFullView: hooks.openFullView,
    onTickerClick: () => {
      hooks.openFullView();
      window.dispatchEvent(new CustomEvent('wm:reveal-panel', { detail: { panelId: 'markets' } }));
    },
  });
  let logOpen = window.innerWidth > 1440;
  const dispatch = new WorldDispatchBar({ onLocate: locateAlert, onToggleLog: () => setLogOpen(!logOpen) });
  const threat = new WorldThreatBadge();
  const clocks = new WorldClockStrip();
  let activeCounter: keyof OpsCounters | null = null;
  const counterFields: Record<keyof OpsCounters, WorldField[]> = {
    wars: ['military'], highConflicts: ['military'], worsening: ['geopolitics'],
    sanctionPairs: ['finance'], aiRelations: [...WORLD_FIELDS], breaking24h: [...WORLD_FIELDS],
    outages: [...WORLD_FIELDS],
  };
  const counters = new WorldOpsCounters((key, button) => {
    activeCounter = activeCounter === key ? null : key;
    counters.setActive(activeCounter);
    updateFields(activeCounter ? counterFields[activeCounter] : [...WORLD_FIELDS]);
    button.blur();
  });
  const eventLog = new WorldEventLog({ onSelectCountry: selectCountry });
  const telemetry = document.createElement('div');
  telemetry.className = 'ops-telemetry-bar';
  telemetry.append(clocks.element, counters.element);
  slots.telemetry.append(telemetry);
  const threatMount = masthead.element.querySelector<HTMLElement>('[data-slot="threat"]');
  threatMount?.append(threat.element);
  slots.stage.append(eventLog.element);
  function setLogOpen(open: boolean): void {
    logOpen = open;
    eventLog.element.dataset.collapsed = String(!open);
    dispatch.setLogState(open, eventLog.element.querySelectorAll('.wfs-ops-event').length);
  }
  setLogOpen(logOpen);
  clocks.start();

  function refreshOps(): void {
    const now = Date.now();
    if (snapshot) {
      const metrics = computeOpsMetrics(snapshot, breakingAlerts.map((alert) => alert.timestamp.getTime()), now, outages);
      threat.setMetrics(metrics);
      counters.setCounters(metrics.counters);
    }
    const events = buildOpsEvents(snapshot, breakingAlerts, now, { outages, disclosures: krDisclosures });
    eventLog.setEvents(events);
    dispatch.setLogState(logOpen, events.length);
  }
  const onBreakingAlert = (event: Event): void => {
    const alert = (event as CustomEvent<BreakingAlert>).detail;
    if (!alert) return;
    breakingAlerts.push(alert);
    if (breakingAlerts.length > 50) breakingAlerts.splice(0, breakingAlerts.length - 50);
    refreshOps();
  };
  document.addEventListener('wm:breaking-news', onBreakingAlert);
  const keyPlate = new WorldKeyPlate();
  const status = new WorldStatusBanner();
  const zoom = new WorldZoomControls({ onZoomIn: () => map.zoomBy(+1), onZoomOut: () => map.zoomBy(-1), onReset: () => map.resetWorldView() });
  const shelf = new WorldBottomShelf({ onFieldsChange: updateFields, onDateChange: (date) => { void loadDate(date); } });
  const drawer = new WorldCountryDrawer({
    onClose: clearSelection,
    onSelectCountry: selectCountry,
    onMark: markItem,
    onOpenFullPanels: (iso2) => hooks.openCountryBrief(iso2),
  });
  const removeCoordAxes = renderCoordAxes(slots.stage);

  slots.masthead.append(masthead.element);
  slots.dispatch.append(dispatch.element);
  slots.shelf.append(shelf.element);
  slots.stage.append(keyPlate.element, zoom.element, status.element, drawer.element);
  keyPlate.setFields(fields);
  shelf.setFields(fields);

  function makeView(): void {
    if (!snapshot) return;
    currentView = buildWorldMapView(snapshot, fields, selectedIso2);
    map.setWorldOverview(currentView);
  }

  function updateDrawer(): void {
    if (!snapshot || !selectedIso2) return;
    const data: CountryDrawerData = { ...buildCountryDrawerData(snapshot, selectedIso2, kstDate(Date.now())), outages: outages
      .filter((outage) => outage.iso2 === selectedIso2 && (outage.end === null || outage.end >= Date.now() - 6 * 60 * 60 * 1000))
      .map(({ id, start, end, severity, signals, url }) => ({ id, start, end, severity, signals, url })),
      ...(selectedIso2 === 'KR' ? { korea: { asOf: krEcos?.asOf ?? 0, indicators: krEcos?.indicators ?? [], trade: krTrade, disclosures: krDisclosures } } : {}) };
    if (drawer.isOpen()) drawer.update(data); else drawer.open(data);
  }

  function selectCountry(iso2: string): void {
    const normalized = iso2.trim().toUpperCase();
    if (!normalized || !snapshot) return;
    selectedIso2 = normalized;
    makeView();
    updateDrawer();
  }

  function clearSelection(): void {
    if (selectedIso2 === null) return;
    selectedIso2 = null;
    makeView();
  }

  function updateFields(next: WorldField[]): void {
    fields = next;
    setWorldFields(fields);
    keyPlate.setFields(fields);
    shelf.setFields(fields);
    makeView();
  }

  async function loadDate(date: string): Promise<void> {
    const generation = ++loadGeneration;
    status.setState('loading');
    try {
      const result = await loadWorldOverview(date);
      if (destroyed || generation !== loadGeneration) return;
      if (!result.snapshot) { status.setState('empty'); return; }
      snapshot = result.snapshot;
      refreshOps();
      lastLoadedAt = Date.now();
      shelf.setDates(mergeDates(result.snapshot.availableDates, result.archivedDates), result.snapshot.date);
      status.setState('ok');
      makeView();
      void refreshExtras();
      startExtrasTimer();
      if (selectedIso2) updateDrawer();
    } catch (error) {
      if (destroyed || generation !== loadGeneration) return;
      status.setState('error', error instanceof Error ? error.message : undefined);
      threat.setError();
    }
  }

  async function loadToday(): Promise<void> {
    const generation = ++loadGeneration;
    status.setState('loading');
    try {
      const result = await loadWorldOverview();
      if (destroyed || generation !== loadGeneration) return;
      if (!result.snapshot) { status.setState('empty'); return; }
      snapshot = result.snapshot;
      refreshOps();
      lastLoadedAt = Date.now();
      shelf.setDates(mergeDates(result.snapshot.availableDates, result.archivedDates), result.snapshot.date);
      status.setState('ok');
      makeView();
      void refreshExtras();
      startExtrasTimer();
      if (selectedIso2) updateDrawer();
    } catch (error) {
      if (destroyed || generation !== loadGeneration) return;
      status.setState('error', error instanceof Error ? error.message : undefined);
      threat.setError();
    }
  }

  async function markItem(request: WorldMarkRequest): Promise<void> {
    try {
      await setWorldMark(request);
      await loadToday();
    } catch (error) {
      if (!destroyed) status.setState('error', error instanceof Error ? error.message : undefined);
    }
  }

  function locateAlert(alert: BreakingAlert): void {
    const coords = alert as BreakingAlert & { lat?: number; lon?: number; latitude?: number; longitude?: number; coordinates?: [number, number] };
    const lat = coords.lat ?? coords.latitude ?? (Array.isArray(coords.coordinates) ? coords.coordinates[1] : undefined);
    const lon = coords.lon ?? coords.longitude ?? (Array.isArray(coords.coordinates) ? coords.coordinates[0] : undefined);
    if (typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)) map.setCenter(lat, lon, 4);
  }

  const onCountryClick = (event: Event): void => {
    const code = (event as CustomEvent<{ code?: unknown }>).detail?.code;
    if (typeof code === 'string') selectCountry(code);
  };
  const onThemeChanged = (): void => { if (currentView) map.setWorldOverview(currentView); };
  window.addEventListener('wm:world:country-click', onCountryClick);
  window.addEventListener('theme-changed', onThemeChanged);
  map.onWorldLineClicked((lineId) => {
    const line = snapshot?.relations.find((candidate) => candidate.id === lineId);
    if (line) selectCountry(line.from);
  });

  const tickerRefresh = (): void => {
    if (destroyed) return;
    void loadTickerItems().then((items) => { if (!destroyed) masthead.setTickerItems([...items, ...buildSupplementalTickerItems({ fundingStress, gasFlows, korea: { ktb10y: (() => { const indicator = krEcos?.indicators.find((entry) => entry.id === 'ktb10y'); return indicator ? { value: indicator.value, changeBp: indicator.changeKind === 'bp' ? indicator.change : null } : null; })(), trade: krTrade } })]); }).catch(() => { /* keep the last row */ });
  };
  async function refreshExtras(): Promise<void> {
    if (destroyed || !worldShown || extrasLoading) return;
    extrasLoading = true;
    const [stressResult, outageResult, gasResult, ecosResult, tradeResult, dartResult] = await Promise.allSettled([loadFundingStress(), loadIodaOutages(), loadEuGasFlows(), loadKrEcosMacro(), loadKrCustomsTrade(), loadKrDartDisclosures()]);
    if (!destroyed) {
      if (stressResult.status === 'fulfilled') fundingStress = stressResult.value;
      if (outageResult.status === 'fulfilled') outages = outageResult.value;
      if (gasResult.status === 'fulfilled') gasFlows = gasResult.value;
      if (ecosResult.status === 'fulfilled') krEcos = ecosResult.value;
      if (tradeResult.status === 'fulfilled') krTrade = tradeResult.value;
      if (dartResult.status === 'fulfilled') krDisclosures = dartResult.value;
      extrasLoadedAt = Date.now();
      refreshOps();
      if (selectedIso2) updateDrawer();
      tickerRefresh();
    }
    extrasLoading = false;
  }
  function startExtrasTimer(): void {
    if (destroyed || !worldShown || extrasTimer !== null) return;
    extrasTimer = setInterval(() => { void refreshExtras(); }, RELOAD_AFTER_MS);
  }
  tickerRefresh();
  let tickerTimer: ReturnType<typeof setInterval> | null = setInterval(tickerRefresh, TICKER_REFRESH_MS);

  void loadToday();
  // Line endpoints resolve from country geometry; redraw once it is loaded.
  void preloadCountryGeometry().then(() => { if (!destroyed) makeView(); }).catch(() => { /* lines stay hidden */ });
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      loadGeneration++;
      window.removeEventListener('wm:world:country-click', onCountryClick);
      document.removeEventListener('wm:breaking-news', onBreakingAlert);
      window.removeEventListener('theme-changed', onThemeChanged);
      map.onWorldLineClicked(() => {});
      if (tickerTimer !== null) clearInterval(tickerTimer);
      tickerTimer = null;
      if (extrasTimer !== null) clearInterval(extrasTimer);
      extrasTimer = null;
      clocks.destroy(); eventLog.destroy(); counters.element.remove(); threat.element.remove(); telemetry.remove();
      removeCoordAxes();
      masthead.destroy(); dispatch.destroy(); shelf.destroy(); drawer.destroy();
      keyPlate.element.remove(); zoom.element.remove(); status.element.remove();
      slots.root.classList.remove('wfs-root');
    },
    onEnter(): void {
      if (destroyed) return;
      worldShown = true;
      map.setWorldOverviewMode(true);
      clocks.start();
      startExtrasTimer();
      if (Date.now() - extrasLoadedAt >= RELOAD_AFTER_MS) void refreshExtras();
      if (currentView) map.setWorldOverview(currentView);
      if (Date.now() - lastLoadedAt > RELOAD_AFTER_MS) void loadToday();
    },
    onLeave(): void {
      worldShown = false;
      clocks.stop();
      if (extrasTimer !== null) clearInterval(extrasTimer);
      extrasTimer = null;
    },
  };
}

function mergeDates(available: string[], archived: string[]): string[] {
  return [...new Set([...available, ...archived])].sort();
}
