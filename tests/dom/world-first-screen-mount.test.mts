import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initTestI18n } from './helpers/i18n.mts';

const mocks = vi.hoisted(() => ({ load: vi.fn(), mark: vi.fn(), stress: vi.fn(), auctions: vi.fn(), outages: vi.fn(), ecos: vi.fn(), trade: vi.fn(), dart: vi.fn(), federalRegister: vi.fn(), fields: ['military', 'geopolitics'] as string[], setFields: vi.fn(), data: {} as Record<string, unknown> }));
vi.mock('@/services/world-overview', () => ({ loadWorldOverview: mocks.load, setWorldMark: mocks.mark }));
vi.mock('@/services/world-overview-view', () => ({ buildWorldMapView: vi.fn((_s, _f, selected) => ({ date: '2026-11-22', countries: {}, lines: [], blocOutlines: [], selectedIso2: selected, relatedIso2: [] })), buildCountryDrawerData: vi.fn((_s, iso2) => ({ iso2, nameKo: iso2, nameEn: iso2, level: null, conflictLevel: null, ciiScore: null, updatedAt: 1, issue: null, relations: [], blocs: [], isToday: true, aiStatus: 'ok' })) }));
vi.mock('@/services/world-first-screen-prefs', () => ({ getWorldFields: () => [...mocks.fields], setWorldFields: mocks.setFields }));
vi.mock('@/services/world-ticker', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/world-ticker')>(),
  loadTickerItems: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/services/funding-stress', () => ({ loadFundingStress: mocks.stress }));
vi.mock('@/services/treasury-auctions', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/treasury-auctions')>(), loadTreasuryAuctions: mocks.auctions,
}));
vi.mock('@/services/internet-outages-ioda', () => ({ loadIodaOutages: mocks.outages }));
vi.mock('@/services/eu-gas-flows', () => ({ loadEuGasFlows: vi.fn(() => Promise.resolve(null)) }));
vi.mock('@/services/kr-ecos', () => ({ loadKrEcosMacro: mocks.ecos }));
vi.mock('@/services/kr-customs-trade', () => ({ loadKrCustomsTrade: mocks.trade }));
vi.mock('@/services/kr-dart', () => ({ loadKrDartDisclosures: mocks.dart }));
vi.mock('@/services/federal-register', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/federal-register')>(),
  loadFederalRegister: mocks.federalRegister,
}));
vi.mock('@/services/country-geometry', () => ({ preloadCountryGeometry: vi.fn(() => new Promise(() => { /* geometry never needed here */ })) }));
import { mountWorldFirstScreen, type WorldFirstScreenSlots } from '../../src/app/world-first-screen';

const snapshot = { date: '2026-11-22', availableDates: ['2026-11-21', '2026-11-22'], countries: {}, relations: [], anchors: {}, blocs: [], ai: { status: 'ok' }, generatedAt: 1 } as never;
function setup() {
  const root = document.createElement('div');
  const createSlot = (key: keyof Omit<WorldFirstScreenSlots, 'root'>) => {
    const node = document.createElement('div');
    node.dataset.slot = key;
    root.append(node);
    return node;
  };
  const slots: WorldFirstScreenSlots = {
    root,
    masthead: createSlot('masthead'),
    telemetry: createSlot('telemetry'),
    dispatch: createSlot('dispatch'),
    stage: createSlot('stage'),
    shelf: createSlot('shelf'),
  };
  const map = { setWorldOverviewMode: vi.fn(), setWorldOverview: vi.fn(), onWorldLineClicked: vi.fn(), zoomBy: vi.fn(), resetWorldView: vi.fn(), setCenter: vi.fn() };
  document.body.append(root);
  const ctx = { map } as never;
  return { root, slots, map, ctx };
}
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); mocks.fields = ['military', 'geopolitics']; mocks.data = {}; mocks.stress.mockResolvedValue(null); mocks.outages.mockResolvedValue([]); mocks.ecos.mockResolvedValue(null); mocks.trade.mockResolvedValue(null); mocks.dart.mockResolvedValue([]); });
beforeEach(() => { mocks.stress.mockResolvedValue(null); mocks.auctions.mockResolvedValue(null); mocks.outages.mockResolvedValue([]); mocks.ecos.mockResolvedValue(null); mocks.trade.mockResolvedValue(null); mocks.dart.mockResolvedValue([]); mocks.federalRegister.mockResolvedValue([]); });

describe('mountWorldFirstScreen', () => {
  it('mounts chrome and reports an empty snapshot', async () => {
    mocks.load.mockResolvedValue({ snapshot: null, archivedDates: [] }); const { slots, map, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} }); await vi.waitFor(() => expect(slots.stage.querySelector('.wfs-status-banner')?.getAttribute('data-state')).toBe('empty'));
    expect(slots.masthead.querySelector('[data-threat="0"]')).not.toBeNull();
    expect(slots.telemetry.querySelector('.wfs-ops-clocks')).not.toBeNull();
    expect(slots.telemetry.querySelectorAll('.wfs-ops-counter-btn')).toHaveLength(6);
    expect(slots.stage.querySelector('.coord-axis-top')).not.toBeNull();
    expect(slots.stage.querySelector('.wfs-ops-event-log')?.getAttribute('data-collapsed')).toBe(String(window.innerWidth <= 1440));
    expect(slots.masthead.children.length).toBeGreaterThan(0); expect(slots.dispatch.children.length).toBeGreaterThan(0); expect(slots.shelf.children.length).toBeGreaterThan(0); expect(map.setWorldOverviewMode).toHaveBeenCalledWith(true); mounted.destroy();
    expect(slots.stage.querySelector('.coord-axis-top')).toBeNull();
  });
  it('keeps the existing view on errors and shows an error banner', async () => {
    mocks.load.mockResolvedValueOnce({ snapshot, archivedDates: [] }).mockRejectedValueOnce(new Error('offline')); const { slots, map, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    await vi.waitFor(() => expect(map.setWorldOverview).toHaveBeenCalled());
    const calls = map.setWorldOverview.mock.calls;
    const previous = calls[calls.length - 1]?.[0];
    slots.shelf.querySelector<HTMLButtonElement>('[data-date-step="-1"]')!.click();
    await vi.waitFor(() => expect(slots.stage.querySelector('.wfs-status-banner')?.getAttribute('data-state')).toBe('error'));
    expect(calls[calls.length - 1]?.[0]).toBe(previous);
    mounted.destroy();
  });
  it('persists field changes, opens country drawer, loads dates, and removes listeners', async () => {
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] }); const { slots, map, ctx } = setup(); const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    await vi.waitFor(() => expect(map.setWorldOverview).toHaveBeenCalled()); slots.shelf.querySelector<HTMLButtonElement>('[data-field="diplomacy"]')!.click(); expect(mocks.setFields).toHaveBeenCalled(); expect(map.setWorldOverview).toHaveBeenCalledTimes(2);
    window.dispatchEvent(new CustomEvent('wm:world:country-click', { detail: { code: 'JP' } })); expect(slots.stage.querySelector('.wfs-country-drawer')?.getAttribute('data-state')).toBe('open');
    slots.shelf.querySelector<HTMLButtonElement>('[data-date-step="-1"]')!.click(); await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledWith('2026-11-21'));
    mounted.destroy(); window.dispatchEvent(new CustomEvent('wm:world:country-click', { detail: { code: 'KR' } })); expect(slots.stage.querySelector('.wfs-country-drawer')).toBeNull();
  });
  it('wires counter filters, log toggle, breaking alerts, and lifecycle timers', async () => {
    vi.useFakeTimers();
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] });
    const { slots, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    await vi.waitFor(() => expect(slots.telemetry.querySelector('.wfs-ops-counters')).not.toBeNull());
    slots.telemetry.querySelector<HTMLButtonElement>('[data-counter="wars"]')!.click();
    expect(slots.telemetry.querySelector('[data-counter="wars"]')?.classList.contains('is-active')).toBe(true);
    expect(mocks.setFields).toHaveBeenCalledWith(['military']);
    slots.dispatch.querySelector<HTMLButtonElement>('#logToggleBtn')!.click();
    expect(slots.stage.querySelector('.wfs-ops-event-log')?.getAttribute('data-collapsed')).toBe('false');
    const alert = { id: 'alert-1', headline: '긴급 속보', source: '테스트', threatLevel: 'critical', timestamp: new Date(), origin: 'rss_alert', countryCode: 'KR', corroboration: {} };
    document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: alert }));
    expect(slots.stage.querySelector('.wfs-ops-event-title')?.textContent).toBe('긴급 속보');
    mounted.onLeave();
    mounted.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('loads the supplemental data after the first map draw and stops its refresh while hidden', async () => {
    vi.useFakeTimers();
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] });
    mocks.stress.mockResolvedValue({ ofrFsi: null, sofr: null });
    mocks.outages.mockResolvedValue([]);
    mocks.ecos.mockResolvedValue(null); mocks.trade.mockResolvedValue(null); mocks.dart.mockResolvedValue([]);
    const { slots, map, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    await vi.waitFor(() => expect(map.setWorldOverview).toHaveBeenCalled());
    await vi.waitFor(() => expect(mocks.outages).toHaveBeenCalledTimes(1));
    expect(mocks.ecos).toHaveBeenCalledTimes(1); expect(mocks.trade).toHaveBeenCalledTimes(1); expect(mocks.dart).toHaveBeenCalledTimes(1);
    expect(map.setWorldOverview).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(mocks.outages).toHaveBeenCalledTimes(2);
    expect(mocks.ecos).toHaveBeenCalledTimes(2); expect(mocks.trade).toHaveBeenCalledTimes(2); expect(mocks.dart).toHaveBeenCalledTimes(2);
    mounted.onLeave();
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    expect(mocks.outages).toHaveBeenCalledTimes(2);
    expect(mocks.ecos).toHaveBeenCalledTimes(2); expect(mocks.trade).toHaveBeenCalledTimes(2); expect(mocks.dart).toHaveBeenCalledTimes(2);
    mounted.destroy();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('opens the Federal Register country card from an event log entry', async () => {
    const doc = {
      id: '2026-22385', date: '2026-11-02', title: 'Tariffs on <imports>', type: 'Proclamation',
      topic: 'tariff', countries: ['JP', 'US'], url: 'https://www.federalregister.gov/documents/2026/11/02/2026-22385/adjusting-imports',
    };
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] });
    mocks.federalRegister.mockResolvedValue([
      doc,
      { ...doc, id: '2026-22384', topic: 'other', title: 'Unrelated determination', countries: ['AU'] },
    ]);
    const { slots, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    try {
      const entry = () => slots.stage.querySelector('li[data-kind="federal-register"]');
      await vi.waitFor(() => expect(entry()?.textContent).toContain(doc.title));
      expect(slots.stage.querySelectorAll('li[data-kind="federal-register"]')).toHaveLength(1);
      expect(entry()?.querySelector('time')?.dateTime).toBe(doc.date);
      expect(entry()?.querySelector('.wfs-ops-event-publication')).toBeNull();
      expect(entry()?.querySelector('a')?.href).toBe(doc.url);
      entry()?.querySelector('button')?.click();
      const card = slots.stage.querySelector('[data-section="federal-register"]');
      expect(card?.textContent).toContain(doc.title);
      expect(card?.textContent).not.toContain('Unrelated determination');
      expect(card?.querySelector('imports')).toBeNull();
      expect(card?.querySelector('a')?.href).toBe(doc.url);
      expect(card?.querySelector('a')?.rel).toBe('noopener noreferrer');

      window.dispatchEvent(new CustomEvent('wm:world:country-click', { detail: { code: 'CA' } }));
      expect(slots.stage.querySelector('[data-section="federal-register"]')).toBeNull();
    } finally {
      mounted.destroy();
    }
  });

  it.each([['ko', '사전 공개'], ['en', 'Pre-publication']])('shows the %s inspection marker and scheduled date in both surfaces', async (language, label) => {
    await initTestI18n();
    await i18next.changeLanguage(language);
    const doc = {
      id: '2026-23939', date: '2026-11-24', filedAt: Date.parse('2026-11-23T13:45:00Z'),
      title: 'Antidumping Duty Proceedings on Tires From China', type: 'Notice',
      topic: 'tariff', countries: ['CN'], url: 'https://www.federalregister.gov/public-inspection/2026-23939/tires',
    };
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] });
    mocks.federalRegister.mockResolvedValue([doc]);
    const { slots, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    try {
      const entry = () => slots.stage.querySelector<HTMLLIElement>('li[data-kind="federal-register"]');
      await vi.waitFor(() => expect(entry()?.querySelector('.wfs-ops-event-publication')?.textContent).toBe(label));
      expect(entry()?.querySelector('time')?.dateTime).toBe(doc.date);
      expect(entry()?.querySelector('a')?.href).toBe(doc.url);
      entry()?.querySelector('button')?.click();
      const card = slots.stage.querySelector('[data-section="federal-register"]');
      expect(card?.querySelector('strong')?.textContent).toBe(label);
      expect(card?.querySelector('time')?.dateTime).toBe(doc.date);
      expect(card?.querySelector('a')?.href).toBe(doc.url);
    } finally {
      mounted.destroy();
      await i18next.changeLanguage('en');
    }
  });

  it('shows weak and strong coupons in the log and a benchmark pair next to funding stress', async () => {
    await initTestI18n();
    await i18next.changeLanguage('ko');
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-23T23:00:00Z'));
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] });
    mocks.stress.mockResolvedValue({ sofr: { rate: 4.25, changeBp: 1 } });
    const coupon = { cusip: '91282CRX1', kind: 'note', term: '10-Year', date: '2026-11-10',
      at: Date.parse('2026-11-10T18:00:00Z'), verdict: 'weak', bidToCover: 2.46, resultsFile: 'R_20261110_1.pdf' };
    mocks.auctions.mockResolvedValue({
      coupons: [coupon, { ...coupon, cusip: '91282CRE3', kind: 'tips', verdict: 'strong' },
        { ...coupon, cusip: '912810UY2', kind: 'bond', term: '30-Year', verdict: 'neutral' }],
      nextBenchmarks: [{ kind: 'note', term: '10-Year', date: '2026-12-08', status: 'tentative' }],
    });
    const { slots, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    try {
      slots.dispatch.querySelector<HTMLButtonElement>('#logToggleBtn')!.click();
      const entries = () => slots.stage.querySelectorAll('li[data-kind="treasury-auction"]');
      await vi.waitFor(() => expect(entries()).toHaveLength(2));
      expect(slots.stage.querySelector('.wfs-ops-event-log')?.getAttribute('data-collapsed')).toBe('false');
      const weak = Array.from(entries()).find((row) => row.textContent?.includes('수요 약세'));
      expect(weak?.textContent).toContain('미 국채 10년 입찰 · 수요 약세 · 2.46×');
      expect(weak?.querySelector('time')?.textContent).toBe('11-10');
      expect(weak?.querySelector('a')?.href).toContain('R_20261110_1.pdf');
      expect(Array.from(entries()).some((row) => row.textContent?.includes('수요 강세'))).toBe(true);
      const ticker = slots.masthead.querySelector('[data-ticker="treasury-auction-latest"]');
      expect(ticker?.previousElementSibling?.getAttribute('data-ticker')).toBe('sofr');
      expect(ticker?.nextElementSibling?.textContent).toContain('잠정 · 미 국채 10년 입찰12-08 ET');
    } finally {
      mounted.destroy();
      vi.useRealTimers();
      await i18next.changeLanguage('en');
    }
  });
});
