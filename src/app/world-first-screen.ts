import type { AppContext } from '@/app/app-context';
import { WorldMasthead, WorldZoomControls, WorldBottomShelf, WorldStatusBanner } from '@/components/world/WorldChrome';
import { BattleEvidenceDrawer, BattleMapChrome, battleButton, battleNode } from '@/components/world/BattleMapChrome';
import { BattleMapOverlay } from '@/components/world/BattleMapOverlay';
import { WorldCountryDrawer } from '@/components/world/WorldCountryDrawer';
import { renderCoordAxes } from '@/components/world/WorldCoordAxes';
import { preloadCountryGeometry } from '@/services/country-geometry';
import { loadWorldOverview, setWorldMark } from '@/services/world-overview';
import { buildCountryDrawerData, buildWorldMapView, countryName, endpointCoord } from '@/services/world-overview-view';
import { battleCountryLabels, battleEndpoint, buildBattleView, buildCountryEventMarkers, filterImpactWindow, type ImpactWindow, pressureLevel } from '@/services/battle-map-view';
import { loadImpactLinks, type CountryImpactEvent, type GetImpactLinksResponse, type ImpactLink } from '@/services/impact-links';
import { IMPACT_KINDS, isImpactKind, type ImpactKind } from '@/config/battle-map';
import { buildSupplementalTickerItems, loadTickerItems } from '@/services/world-ticker';
import { loadFundingStress } from '@/services/funding-stress';
import type { FundingStress } from '@/services/funding-stress';
import { loadTreasuryAuctions, type TreasuryAuctions } from '@/services/treasury-auctions';
import { globalIndicatorEvents, globalIndicatorGauges, loadGlobalIndicators, type GlobalIndicators } from '@/services/global-indicators';
import { renderGlobalGauges } from '@/components/world/WorldGlobalGauges';
import { getCurrentLanguage } from '@/services/i18n';
import { loadIodaOutages } from '@/services/internet-outages-ioda';
import { loadFederalRegister } from '@/services/federal-register';
import type { IodaOutage } from '@/services/internet-outages-ioda';
import { loadEuGasFlows } from '@/services/eu-gas-flows';
import type { EuGasFlows } from '@/services/eu-gas-flows';
import { getCurrentTheme, setTheme } from '@/utils/theme-manager';
import { safeStorageGet, safeStorageSet } from '@/utils/safe-storage';
import { kstDate } from '../../shared/world-overview.js';
import type { CountryDrawerData, FederalRegisterDocument, WorldMapView, WorldMarkRequest } from '@/types/world-overview';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import { WorldClockStrip, WorldEventLog, WorldThreatBadge } from '@/components/world/WorldOps';
import { buildOpsEvents, computeOpsMetrics } from '@/services/world-ops';
import { loadKrEcosMacro } from '@/services/kr-ecos';
import type { KrEcosMacro } from '@/services/kr-ecos';
import { loadKrCustomsTrade } from '@/services/kr-customs-trade';
import type { KrCustomsTrade } from '@/services/kr-customs-trade';
import { loadKrDartDisclosures } from '@/services/kr-dart';
import type { KrDartDisclosure } from '@/services/kr-dart';

export interface WorldFirstScreenSlots {
  root: HTMLElement;
  masthead: HTMLElement;
  /** Clocks, gauges, and Battle Map counters. */
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
  let snapshot: WorldSnapshot | null = null;
  let currentView: WorldMapView | null = null;
  let selectedIso2: string | null = null;
  let selectedLink: ImpactLink | null = null;
  let selectedEvent: CountryImpactEvent | null = null;
  let selectedAlert: BreakingAlert | null = null;
  let returnCountry: string | null = null;
  let selectionTrigger: HTMLElement | SVGElement | null = null;
  let archive = false;
  let latestDate = '';
  let cii = false;
  let linkListOpen = false;
  let frontOnly = false;
  let impactWindow: ImpactWindow = '7d';
  const activeKinds = new Set<ImpactKind>();
  const domesticKey = 'worldmonitor-battle-domestic-events';
  let domestic = safeStorageGet(domesticKey) === 'true';
  let previewedLink: ImpactLink | null = null;
  let previewAdded = false;
  let impactData: GetImpactLinksResponse | null = null;
  let impactLoading = false;
  let impactError = false;
  let battle = buildBattleView([], {}, 0, null, null);
  let filteredLinks: ImpactLink[] = [];
  let countryEvents: CountryImpactEvent[] = [];
  let lastLoadedAt = 0;
  let loadGeneration = 0;
  let destroyed = false;
  let fundingStress: FundingStress | null = null;
  let treasuryAuctions: TreasuryAuctions | null = null;
  let globalIndicators: GlobalIndicators | null = null;
  let outages: IodaOutage[] = [];
  let federalRegister: FederalRegisterDocument[] = [];
  let gasFlows: EuGasFlows | null = null;
  let krEcos: KrEcosMacro | null = null;
  let krTrade: KrCustomsTrade | null = null;
  let krDisclosures: KrDartDisclosure[] = [];
  let extrasLoadedAt = 0;
  let extrasLoading = false;
  let extrasTimer: ReturnType<typeof setInterval> | null = null;
  let worldShown = true;
  const breakingAlerts: BreakingAlert[] = [];

  slots.root.classList.add('wfs-root', 'battle-map');
  map.setWorldOverviewMode(true);

  const masthead = new WorldMasthead({
    onToggleTheme: () => setTheme(getCurrentTheme() === 'dark' ? 'light' : 'dark'),
    onOpenFullView: hooks.openFullView,
    onTickerClick: () => {
      hooks.openFullView();
      window.dispatchEvent(new CustomEvent('wm:reveal-panel', { detail: { panelId: 'markets' } }));
    },
  });
  let logOpen = false;
  const chrome = new BattleMapChrome({
    selectLink: (link, trigger) => {
      if (selectedLink?.id === link.id) clearSelection();
      else openLink(link, trigger);
    },
    previewLink,
    locate: locateAlert,
    toggleLog: () => {
      if (!logOpen) clearSelection(false);
      setLogOpen(!logOpen);
    },
    chooseKind: toggleKind,
    allKinds: () => { activeKinds.clear(); frontOnly = false; applyFilters(); },
    showList: showLinkList,
    setWindow: changeWindow,
    setCii: (enabled) => { cii = enabled; makeView(); },
    toggleDomestic: () => {
      domestic = !domestic;
      safeStorageSet(domesticKey, String(domestic));
      makeView();
    },
    focusFront: () => { frontOnly = !frontOnly; applyFilters(); },
    retry: () => { void refreshImpact(); },
  });
  const threat = new WorldThreatBadge();
  const clocks = new WorldClockStrip();
  const eventLog = new WorldEventLog({ onSelectCountry: selectCountry });
  const telemetry = document.createElement('div');
  telemetry.className = 'ops-telemetry-bar';
  const gaugeInline = battleNode('div', 'bm-gauges-inline');
  const gaugeDetails = battleNode('details', 'bm-gauges');
  const gaugeSummary = battleNode('summary', '', '지표');
  const gauges = battleNode('section', 'bm-gauges-popup');
  gaugeDetails.hidden = true;
  gaugeDetails.append(gaugeSummary, gauges);
  telemetry.append(clocks.element, gaugeInline, gaugeDetails, chrome.counters, chrome.sources);
  slots.telemetry.append(telemetry);
  const threatMount = masthead.element.querySelector<HTMLElement>('[data-slot="threat"]');
  threatMount?.append(threat.element);
  slots.stage.append(eventLog.element);
  const logHeader = document.createElement('header');
  logHeader.className = 'bm-log-header';
  logHeader.append(document.createTextNode('이벤트 로그'), battleButton('닫기', () => { setLogOpen(false); chrome.logToggle.focus(); }));
  eventLog.element.prepend(logHeader);
  function setLogOpen(open: boolean): void {
    logOpen = open;
    eventLog.element.dataset.collapsed = String(!open);
    eventLog.element.inert = !open;
    chrome.setLog(open, eventLog.element.querySelectorAll('.wfs-ops-event').length);
  }
  setLogOpen(logOpen);
  clocks.start();

  function refreshOps(): void {
    const now = Date.now();
    if (snapshot) {
      const metrics = computeOpsMetrics(snapshot, breakingAlerts.map((alert) => alert.timestamp.getTime()), now, outages);
      threat.setMetrics(metrics);
    }
    const language = getCurrentLanguage();
    const events = buildOpsEvents(snapshot, breakingAlerts, now, {
      outages, disclosures: krDisclosures, federalRegister, treasuryCoupons: treasuryAuctions?.coupons, language,
      indicatorEvents: globalIndicators ? globalIndicatorEvents(globalIndicators, language, now) : [],
    });
    eventLog.setEvents(events);
    chrome.setLog(logOpen, events.length);
  }
  const onBreakingAlert = (event: Event): void => {
    const alert = (event as CustomEvent<BreakingAlert>).detail;
    if (!alert) return;
    breakingAlerts.push(alert);
    if (breakingAlerts.length > 50) breakingAlerts.splice(0, breakingAlerts.length - 50);
    refreshOps();
    renderToday();
  };
  document.addEventListener('wm:breaking-news', onBreakingAlert);
  const status = new WorldStatusBanner();
  const zoom = new WorldZoomControls({ onZoomIn: () => map.zoomBy(+1), onZoomOut: () => map.zoomBy(-1), onReset: () => map.resetWorldView() });
  const shelf = new WorldBottomShelf({ onDateChange: (date) => { void loadDate(date); } }, chrome);
  const drawer = new WorldCountryDrawer({
    onClose: clearSelection,
    onSelectCountry: selectCountry,
    onMark: markItem,
    onOpenFullPanels: (iso2) => hooks.openCountryBrief(iso2),
    onImpact: (link, trigger) => openLink(link, trigger, true),
    onCountryEvent: (event, trigger) => openCountryEvent(event, trigger, true),
  });
  const evidence = new BattleEvidenceDrawer(() => clearSelection(), selectCountry);
  const overlay = new BattleMapOverlay(() => map.worldProjector());
  map.onWorldProjectionChanged(() => overlay.reproject());
  const removeCoordAxes = renderCoordAxes(slots.stage);

  slots.masthead.append(masthead.element);
  slots.dispatch.append(chrome.strip);
  slots.shelf.append(shelf.element);
  slots.stage.append(overlay.element, chrome.legend, zoom.element, status.element, chrome.status, drawer.element, evidence.element);

  function renderImpactOverlay(extra?: (typeof battle.arcs)[number]): void {
    const anchors = snapshot?.anchors ?? {};
    const arcs = extra ? [...battle.arcs, extra] : battle.arcs;
    const eventMarkers = domestic ? buildCountryEventMarkers(countryEvents, anchors) : [];
    overlay.setView(arcs, battleCountryLabels(arcs, anchors), battle.crests, eventMarkers, !activeKinds.size && !frontOnly && !selectedIso2, {
      selectLink: (arc) => openLink(arc.link, findImpactTrigger(arc.link.id)),
      selectCountry,
      selectEvent: openCountryEvent,
    });
    chrome.setLegend(cii || archive, arcs, eventMarkers.map(({ event }) => event), impactData?.sources?.find((source) => source.id === 'ucdp')?.dataAsOf ?? 0);
  }

  function previewLink(link: ImpactLink | null): void {
    if (previewedLink?.id === link?.id) return;
    previewedLink = link;
    const extra = link && !battle.arcs.some((arc) => arc.link.id === link.id)
      ? buildBattleView([], snapshot?.anchors ?? {}, Date.now(), null, link).arcs[0] : undefined;
    if (extra || previewAdded) renderImpactOverlay(extra);
    previewAdded = Boolean(extra);
    overlay.highlight(link && (extra || battle.arcs.some((arc) => arc.link.id === link.id)) ? link.id : null);
  }

  function makeView(): void {
    const now = Date.now();
    const anchors = snapshot?.anchors ?? {};
    const windowLinks = archive ? [] : filterImpactWindow(impactData?.links ?? [], impactWindow, now);
    countryEvents = archive ? [] : filterImpactWindow(impactData?.countryEvents ?? [], impactWindow, now);
    filteredLinks = windowLinks.filter((link) => isImpactKind(link.kind) && (!activeKinds.size || activeKinds.has(link.kind)));
    battle = buildBattleView(filteredLinks, anchors, now, selectedIso2, selectedLink, activeKinds.size > 0);
    const fronts = battle.fronts.length;
    if (frontOnly) {
      const frontCodes = new Set(battle.fronts);
      filteredLinks = filteredLinks.filter((link) => frontCodes.has(link.target));
      battle = buildBattleView(filteredLinks, anchors, now, selectedIso2, selectedLink, true);
    }
    const fillCii = cii || archive;
    const selected = selectedIso2 ?? selectedLink?.target ?? selectedEvent?.country ?? selectedAlert?.countryCode ?? null;
    const overview = snapshot && fillCii ? buildWorldMapView(snapshot, ['military'], selected) : null;
    const countries: WorldMapView['countries'] = fillCii ? overview?.countries ?? {} : {};
    if (!fillCii) {
      for (const [code, score] of Object.entries(battle.pressure)) {
        countries[code] = { iso2: code, level: pressureLevel(score), unrestOutline: false, blocIds: [] };
      }
    }
    for (const code of [...battle.related, selected]) {
      if (code) countries[code] ??= { iso2: code, level: 0, unrestOutline: false, blocIds: [] };
    }
    currentView = { date: snapshot?.date ?? '', countries, pressure: !fillCii, lines: [], blocOutlines: [], selectedIso2: selected,
      relatedIso2: battle.related, hotspots: [] };
    map.setWorldOverview(currentView);
    previewedLink = null;
    previewAdded = false;
    renderImpactOverlay();
    overlay.highlight(null);
    chrome.setFilters(activeKinds, windowLinks, impactWindow, battle.arcs.length, fronts, frontOnly, domestic, now);
    chrome.setSources(archive ? [] : impactData?.sources ?? [], impactData?.generatedAt ?? 0);
    const state = archive ? 'archive' : impactError ? 'error' : !impactData && impactLoading ? 'loading'
      : !impactData?.links.length && !impactData?.countryEvents?.length ? 'empty' : !filteredLinks.length ? 'filtered' : 'ok';
    chrome.setStatus(state, impactWindow);
    renderToday();
  }

  function updateDrawer(): void {
    const code = selectedIso2;
    if (!code) return;
    const base = snapshot ? buildCountryDrawerData(snapshot, code, kstDate(Date.now())) : {
      iso2: code, nameKo: countryName(code, 'ko'), nameEn: countryName(code, 'en'), ciiScore: null,
      level: null, conflictLevel: null, updatedAt: 0, issue: null, relations: [], blocs: [], aiStatus: 'missing' as const, isToday: false,
    };
    const data: CountryDrawerData = { ...base, outages: outages
      .filter((outage) => outage.iso2 === selectedIso2 && (outage.end === null || outage.end >= Date.now() - 6 * 60 * 60 * 1000))
      .map(({ id, start, end, severity, signals, url }) => ({ id, start, end, severity, signals, url })),
      federalRegister: federalRegister.filter((item) => selectedIso2 && item.countries.includes(selectedIso2)).slice(0, 5),
      indicators: globalIndicators ? globalIndicatorGauges(globalIndicators, getCurrentLanguage(), code) : [],
      ...(code === 'KR' ? { korea: { asOf: krEcos?.asOf ?? 0, indicators: krEcos?.indicators ?? [], trade: krTrade, disclosures: krDisclosures } } : {}),
      countryEvents: countryEvents.filter((event) => event.country === code),
      ...(!archive ? { impact: {
        incomingScore: battle.pressure[code] ?? 0,
        incoming: battle.ranked.filter((link) => !link.undirected && link.target === code),
        outgoing: battle.ranked.filter((link) => !link.undirected && link.actor === code),
        bilateral: battle.ranked.filter((link) => link.undirected && (link.actor === code || link.target === code)),
      } } : {}) };
    if (drawer.isOpen()) drawer.update(data); else drawer.open(data);
  }

  function selectCountry(iso2: string): void {
    const normalized = iso2.trim().toUpperCase();
    if (!/^[A-Z]{2}$/.test(normalized)) return;
    selectedLink = null;
    selectedEvent = null;
    selectedAlert = null;
    returnCountry = null;
    linkListOpen = false;
    map.endWorldEvidenceFocus();
    evidence.hide();
    setLogOpen(false);
    if (selectedIso2 !== normalized) drawer.close(false);
    selectedIso2 = normalized;
    makeView();
    updateDrawer();
    drawer.element.querySelector<HTMLElement>('[data-action="close"]')?.focus({ preventScroll: true });
  }

  function clearSelection(restoreFocus = true): void {
    if (!selectedIso2 && !selectedLink && !selectedEvent && !selectedAlert && !linkListOpen) return;
    const previousLink = selectedLink;
    const previousEvent = selectedEvent;
    const trigger = selectionTrigger;
    const back = returnCountry;
    selectedIso2 = null;
    selectedLink = null;
    selectedEvent = null;
    selectedAlert = null;
    returnCountry = null;
    selectionTrigger = null;
    linkListOpen = false;
    drawer.close(false);
    map.endWorldEvidenceFocus();
    evidence.hide();
    if (restoreFocus && back) {
      selectCountry(back);
      drawer.element.querySelector<HTMLElement>(previousEvent ? '[data-section="country-events"] button' : '[data-section="impact"] button')?.focus();
      return;
    }
    makeView();
    if (restoreFocus) (trigger?.isConnected ? trigger : findImpactTrigger(previousLink?.id ?? previousEvent?.id)
      ?? (trigger?.classList.contains('bm-breaking') ? chrome.strip.querySelector<HTMLElement>('.bm-breaking') : null))?.focus();
  }

  function findImpactTrigger(id: string | undefined): HTMLElement | SVGElement | null {
    if (!id) return null;
    return [...slots.root.querySelectorAll<HTMLElement | SVGElement>('[data-impact-id], [data-link-id], [data-event-id]')]
      .find((node) => node.dataset.impactId === id || node.dataset.linkId === id || node.dataset.eventId === id) ?? null;
  }

  function openLink(link: ImpactLink, trigger: HTMLElement | SVGElement | null = null, fromCountry = false): void {
    if (fromCountry) returnCountry = selectedIso2;
    if (trigger) selectionTrigger = trigger;
    selectedIso2 = null;
    selectedLink = link;
    selectedEvent = null;
    selectedAlert = null;
    drawer.close(false);
    setLogOpen(false);
    makeView();
    const bundle = filteredLinks.filter((candidate) => candidate.actor === link.actor && candidate.target === link.target);
    evidence.showLink(link, bundle, (candidate) => openLink(candidate));
    finishEvidenceOpen();
    const from = battleEndpoint(link.actor, snapshot?.anchors ?? {});
    const to = battleEndpoint(link.target, snapshot?.anchors ?? {});
    if (from && to) map.focusWorldEvidence(from, to, evidence.element.getBoundingClientRect());
  }

  function openCountryEvent(event: CountryImpactEvent, trigger: HTMLElement | SVGElement, fromCountry = false): void {
    returnCountry = fromCountry ? selectedIso2 : null;
    selectionTrigger = trigger;
    selectedIso2 = null;
    selectedLink = null;
    selectedAlert = null;
    selectedEvent = event;
    drawer.close(false);
    setLogOpen(false);
    makeView();
    evidence.showCountryEvent(event);
    finishEvidenceOpen();
    const at = endpointCoord(event.country, snapshot?.anchors ?? {});
    if (at) map.focusWorldEvidence(at, at, evidence.element.getBoundingClientRect());
  }

  function finishEvidenceOpen(): void {
    if (returnCountry) evidence.element.querySelector('header')?.append(battleButton(`← ${countryName(returnCountry, 'ko')} 브리핑`, () => clearSelection()));
    evidence.element.querySelector<HTMLButtonElement>('header button')?.focus({ preventScroll: true });
  }

  function showLinkList(trigger: HTMLElement): void {
    clearSelection(false);
    setLogOpen(false);
    selectionTrigger = trigger;
    linkListOpen = true;
    evidence.showList(battle.ranked, (link) => openLink(link));
    evidence.element.querySelector<HTMLButtonElement>('header button')?.focus();
  }

  function applyFilters(): void {
    if (selectedLink || linkListOpen) clearSelection(false);
    else makeView();
    if (selectedIso2) updateDrawer();
  }

  function toggleKind(kind: ImpactKind): void {
    if (activeKinds.has(kind)) activeKinds.delete(kind);
    else activeKinds.add(kind);
    applyFilters();
  }

  function changeWindow(window: ImpactWindow): void {
    impactWindow = window;
    if (selectedEvent && !filterImpactWindow([selectedEvent], window, Date.now()).length) clearSelection(false);
    applyFilters();
  }

  function renderToday(): void {
    previewLink(null);
    const now = Date.now();
    const latestAlert = breakingAlerts[breakingAlerts.length - 1];
    const alert = !archive && latestAlert && latestAlert.timestamp.getTime() >= now - 86_400_000 ? latestAlert : undefined;
    const today = archive ? [] : (impactData?.summary?.today ?? []).filter((link) =>
      link.lastSeen >= now - 86_400_000 && isImpactKind(link.kind) && (!activeKinds.size || activeKinds.has(link.kind))).slice(0, alert ? 6 : 7);
    chrome.setToday(today, alert, selectedLink?.id, now, archive ? '보관 날짜 보기'
      : impactLoading && !impactData ? '집계 불러오는 중' : '최근 24시간의 신규·급등 영향선 없음');
  }

  async function refreshImpact(): Promise<void> {
    if (destroyed || !worldShown || impactLoading) return;
    impactLoading = true;
    if (!impactData) makeView();
    try {
      const result = await loadImpactLinks({ window: '7d', limit: 500 });
      if (destroyed) return;
      if (!Array.isArray(result.links)) throw new Error('Invalid impact-links response');
      impactData = result;
      impactError = false;
    } catch {
      impactError = true;
    } finally {
      impactLoading = false;
      if (!destroyed && worldShown) {
        makeView();
        if (selectedIso2) updateDrawer();
      }
    }
  }

  async function loadDate(date: string): Promise<void> {
    if (date === latestDate) { await loadToday(); return; }
    const generation = ++loadGeneration;
    status.setState('loading');
    try {
      const result = await loadWorldOverview(date);
      if (destroyed || generation !== loadGeneration) return;
      if (!result.snapshot) { status.setState('empty'); return; }
      snapshot = result.snapshot;
      archive = true;
      clearSelection(false);
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
      archive = false;
      latestDate = result.snapshot.date;
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

  function locateAlert(alert: BreakingAlert, trigger: HTMLElement): void {
    clearSelection(false);
    setLogOpen(false);
    selectedAlert = alert;
    selectionTrigger = trigger;
    const coords = alert as BreakingAlert & { lat?: number; lon?: number; latitude?: number; longitude?: number; coordinates?: [number, number] };
    const lat = coords.lat ?? coords.latitude ?? (Array.isArray(coords.coordinates) ? coords.coordinates[1] : undefined);
    const lon = coords.lon ?? coords.longitude ?? (Array.isArray(coords.coordinates) ? coords.coordinates[0] : undefined);
    const at: [number, number] | null = typeof lat === 'number' && typeof lon === 'number' && Number.isFinite(lat) && Number.isFinite(lon)
      ? [lon, lat] : alert.countryCode ? endpointCoord(alert.countryCode, snapshot?.anchors ?? {}) : null;
    makeView();
    evidence.showBreaking(alert, at !== null);
    finishEvidenceOpen();
    if (at) map.focusWorldEvidence(at, at, evidence.element.getBoundingClientRect());
  }

  const onCountryClick = (event: Event): void => {
    const code = (event as CustomEvent<{ code?: unknown }>).detail?.code;
    if (typeof code === 'string') selectCountry(code);
  };
  const onThemeChanged = (): void => { if (currentView) map.setWorldOverview(currentView); };
  window.addEventListener('wm:world:country-click', onCountryClick);
  window.addEventListener('theme-changed', onThemeChanged);
  const onKeyDown = (event: KeyboardEvent): void => {
    if (!worldShown || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey
      || (event.target instanceof HTMLElement && event.target.closest('input, select, textarea, [contenteditable="true"]'))) return;
    if (event.key === 'Escape') {
      if (selectedLink || selectedEvent || selectedAlert || linkListOpen) clearSelection();
      else if (logOpen) { setLogOpen(false); chrome.logToggle.focus(); }
      else if (chrome.legend.dataset.open === 'true') chrome.legend.querySelector<HTMLButtonElement>('.bm-legend-toggle')?.click();
      return;
    }
    if (event.key.toLowerCase() === 't') changeWindow(impactWindow === '7d' ? '24h' : '7d');
    const kind = IMPACT_KINDS[Number(event.key) - 1];
    if (kind) toggleKind(kind);
  };
  document.addEventListener('keydown', onKeyDown);

  const tickerRefresh = (): void => {
    if (destroyed) return;
    void loadTickerItems().then((items) => {
      if (destroyed) return;
      const indicator = krEcos?.indicators.find((entry) => entry.id === 'ktb10y');
      const ktb10y = indicator ? { value: indicator.value, changeBp: indicator.changeKind === 'bp' ? indicator.change : null } : null;
      masthead.setTickerItems([...items, ...buildSupplementalTickerItems({
        fundingStress, treasuryAuctions, gasFlows, korea: { ktb10y, trade: krTrade },
      }, getCurrentLanguage())]);
    }).catch(() => { /* keep the last row */ });
  };
  async function refreshIndicators(): Promise<void> {
    const data = await loadGlobalIndicators();
    if (destroyed) return;
    globalIndicators = data;
    const language = getCurrentLanguage();
    const values = globalIndicatorGauges(data, language);
    renderGlobalGauges(gauges, values, '글로벌 지표');
    gaugeDetails.hidden = values.length === 0;
    gaugeSummary.textContent = `지표 ${values.length}`;
    const shortLabels: Record<string, string> = { cli: 'CLI', gpr: 'GPR', cofer: 'USD', 'pink-energy': '에너지', 'pink-food': '식품' };
    gaugeInline.replaceChildren(...values.map((gauge) => {
      const compact = battleNode('span', 'bm-gauge-inline', `${shortLabels[gauge.id] ?? gauge.label} ${gauge.value.split(' · ')[gauge.id === 'cli' ? 1 : 0] ?? gauge.value}`);
      compact.title = `${gauge.label} ${gauge.value} · ${gauge.period}`;
      return compact;
    }));
    refreshOps();
    if (selectedIso2) updateDrawer();
  }
  async function refreshExtras(): Promise<void> {
    if (destroyed || !worldShown || extrasLoading) return;
    extrasLoading = true;
    const [stressResult, outageResult, gasResult, ecosResult, tradeResult, dartResult, registerResult, auctionsResult] = await Promise.allSettled([
      loadFundingStress(), loadIodaOutages(), loadEuGasFlows(), loadKrEcosMacro(),
      loadKrCustomsTrade(), loadKrDartDisclosures(), loadFederalRegister(), loadTreasuryAuctions(),
    ]);
    if (!destroyed) {
      if (stressResult.status === 'fulfilled') fundingStress = stressResult.value;
      if (outageResult.status === 'fulfilled') outages = outageResult.value;
      if (gasResult.status === 'fulfilled') gasFlows = gasResult.value;
      if (ecosResult.status === 'fulfilled') krEcos = ecosResult.value;
      if (tradeResult.status === 'fulfilled') krTrade = tradeResult.value;
      if (dartResult.status === 'fulfilled') krDisclosures = dartResult.value;
      if (registerResult.status === 'fulfilled') federalRegister = registerResult.value;
      if (auctionsResult.status === 'fulfilled') treasuryAuctions = auctionsResult.value;
      extrasLoadedAt = Date.now();
      refreshOps();
      if (selectedIso2) updateDrawer();
      tickerRefresh();
    }
    extrasLoading = false;
  }
  function startExtrasTimer(): void {
    if (destroyed || !worldShown || extrasTimer !== null) return;
    extrasTimer = setInterval(() => {
      void refreshIndicators();
      void refreshExtras();
      void refreshImpact();
    }, RELOAD_AFTER_MS);
  }
  tickerRefresh();
  let tickerTimer: ReturnType<typeof setInterval> | null = setInterval(tickerRefresh, TICKER_REFRESH_MS);

  void loadToday();
  void refreshImpact();
  void refreshIndicators();
  startExtrasTimer();
  // Line endpoints resolve from country geometry; redraw once it is loaded.
  void preloadCountryGeometry().then(() => { if (!destroyed) makeView(); }).catch(() => { /* lines stay hidden */ });
  return {
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      loadGeneration++;
      window.removeEventListener('wm:world:country-click', onCountryClick);
      document.removeEventListener('wm:breaking-news', onBreakingAlert);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('theme-changed', onThemeChanged);
      map.onWorldProjectionChanged(null);
      if (tickerTimer !== null) clearInterval(tickerTimer);
      tickerTimer = null;
      if (extrasTimer !== null) clearInterval(extrasTimer);
      extrasTimer = null;
      clocks.destroy(); eventLog.destroy(); threat.element.remove(); telemetry.remove();
      removeCoordAxes();
      masthead.destroy(); chrome.strip.remove(); shelf.destroy(); drawer.destroy();
      chrome.legend.remove(); chrome.status.remove(); evidence.element.remove(); overlay.destroy();
      zoom.element.remove(); status.element.remove();
      slots.root.classList.remove('wfs-root', 'battle-map');
    },
    onEnter(): void {
      if (destroyed) return;
      worldShown = true;
      map.setWorldOverviewMode(true);
      clocks.start();
      startExtrasTimer();
      if (Date.now() - extrasLoadedAt >= RELOAD_AFTER_MS) {
        void refreshIndicators();
        void refreshExtras();
      }
      makeView();
      if (!archive && Date.now() - lastLoadedAt > RELOAD_AFTER_MS) void loadToday();
      if (Date.now() - (impactData?.generatedAt ?? 0) > RELOAD_AFTER_MS) void refreshImpact();
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
