import type { AppContext } from '@/app/app-context';
import { WorldMasthead, WorldDispatchBar, WorldKeyPlate, WorldZoomControls, WorldBottomShelf, WorldStatusBanner } from '@/components/world/WorldChrome';
import { WorldCountryDrawer } from '@/components/world/WorldCountryDrawer';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { loadWorldOverview, setWorldMark } from '@/services/world-overview';
import { buildCountryDrawerData, buildWorldMapView } from '@/services/world-overview-view';
import { loadTickerItems } from '@/services/world-ticker';
import { getWorldFields, setWorldFields } from '@/services/world-first-screen-prefs';
import { getCurrentTheme, setTheme } from '@/utils/theme-manager';
import { kstDate } from '../../shared/world-overview.js';
import type { CountryDrawerData, WorldField, WorldMapView, WorldMarkRequest } from '@/types/world-overview';
import type { BreakingAlert } from '@/services/breaking-news-alerts';

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
): { destroy(): void; onEnter(): void } {
  if (!ctx.map) throw new Error('MapContainer must exist before mounting the world first screen');
  const map = ctx.map!;
  let fields = getWorldFields();
  let snapshot: WorldSnapshot | null = null;
  let currentView: WorldMapView | null = null;
  let selectedIso2: string | null = null;
  let lastLoadedAt = 0;
  let loadGeneration = 0;
  let destroyed = false;

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
  const dispatch = new WorldDispatchBar({ onLocate: locateAlert });
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
    const data: CountryDrawerData = buildCountryDrawerData(snapshot, selectedIso2, kstDate(Date.now()));
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
      lastLoadedAt = Date.now();
      shelf.setDates(mergeDates(result.snapshot.availableDates, result.archivedDates), result.snapshot.date);
      status.setState('ok');
      makeView();
      if (selectedIso2) updateDrawer();
    } catch (error) {
      if (destroyed || generation !== loadGeneration) return;
      status.setState('error', error instanceof Error ? error.message : undefined);
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
      lastLoadedAt = Date.now();
      shelf.setDates(mergeDates(result.snapshot.availableDates, result.archivedDates), result.snapshot.date);
      status.setState('ok');
      makeView();
      if (selectedIso2) updateDrawer();
    } catch (error) {
      if (destroyed || generation !== loadGeneration) return;
      status.setState('error', error instanceof Error ? error.message : undefined);
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
    void loadTickerItems().then((items) => { if (!destroyed) masthead.setTickerItems(items); }).catch(() => { /* keep the last row */ });
  };
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
      window.removeEventListener('theme-changed', onThemeChanged);
      map.onWorldLineClicked(() => {});
      if (tickerTimer !== null) clearInterval(tickerTimer);
      tickerTimer = null;
      masthead.destroy(); dispatch.destroy(); shelf.destroy(); drawer.destroy();
      keyPlate.element.remove(); zoom.element.remove(); status.element.remove();
      slots.root.classList.remove('wfs-root');
    },
    onEnter(): void {
      if (destroyed) return;
      map.setWorldOverviewMode(true);
      if (currentView) map.setWorldOverview(currentView);
      if (Date.now() - lastLoadedAt > RELOAD_AFTER_MS) void loadToday();
    },
  };
}

function mergeDates(available: string[], archived: string[]): string[] {
  return [...new Set([...available, ...archived])].sort();
}
