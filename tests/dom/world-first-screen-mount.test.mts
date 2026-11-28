import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initTestI18n } from './helpers/i18n.mts';

const mocks = vi.hoisted(() => ({ load: vi.fn(), impacts: vi.fn(), mark: vi.fn(), stress: vi.fn(), auctions: vi.fn(), outages: vi.fn(), ecos: vi.fn(), trade: vi.fn(), dart: vi.fn(), federalRegister: vi.fn(), data: {} as Record<string, unknown> }));
vi.mock('@/services/world-overview', () => ({ loadWorldOverview: mocks.load, setWorldMark: mocks.mark }));
vi.mock('@/services/world-overview-view', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/world-overview-view')>(),
  buildCountryDrawerData: vi.fn((_s, iso2) => ({ iso2, nameKo: iso2, nameEn: iso2, level: null, conflictLevel: null, ciiScore: null, updatedAt: 1, issue: null, relations: [], blocs: [], isToday: true, aiStatus: 'ok' })),
}));
vi.mock('@/services/impact-links', () => ({ loadImpactLinks: mocks.impacts }));
vi.mock('@/services/world-ticker', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/world-ticker')>(),
  loadTickerItems: vi.fn(() => Promise.resolve([])),
}));
vi.mock('@/services/funding-stress', () => ({ loadFundingStress: mocks.stress }));
vi.mock('@/services/bootstrap', () => ({ ensureHydrated: vi.fn((key: string) => Promise.resolve(mocks.data[key])) }));
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
vi.mock('@/services/country-geometry', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/country-geometry')>(),
  preloadCountryGeometry: vi.fn(() => new Promise(() => { /* geometry never needed here */ })),
}));
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
  const map = { setWorldOverviewMode: vi.fn(), setWorldOverview: vi.fn(), onWorldProjectionChanged: vi.fn(), worldProjector: () => null, zoomBy: vi.fn(), resetWorldView: vi.fn(), setCenter: vi.fn() };
  document.body.append(root);
  const ctx = { map } as never;
  return { root, slots, map, ctx };
}
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); vi.useRealTimers(); mocks.data = {}; });
beforeEach(() => {
  mocks.impacts.mockResolvedValue({ generatedAt: 0, links: [], summary: { today: [], byCountry: {} }, sources: [] });
  mocks.stress.mockResolvedValue(null); mocks.auctions.mockResolvedValue(null); mocks.outages.mockResolvedValue([]);
  mocks.ecos.mockResolvedValue(null); mocks.trade.mockResolvedValue(null); mocks.dart.mockResolvedValue([]); mocks.federalRegister.mockResolvedValue([]);
});

describe('mountWorldFirstScreen', () => {
  it('renders available gauges while the world snapshot and supplemental data are pending', async () => {
    mocks.data = { imfCofer: { latest: { period: '2026-Q2', shares: { USD: 56.7 } } } };
    mocks.load.mockImplementationOnce(() => new Promise(() => {}));
    const { slots, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    try {
      await vi.waitFor(() => expect(slots.telemetry.querySelector('[data-gauge="cofer"]')?.textContent).toContain('56.7%'));
      expect(slots.stage.querySelector('.wfs-status-banner')?.getAttribute('data-state')).toBe('loading');
      expect(mocks.stress).not.toHaveBeenCalled();
    } finally {
      mounted.destroy();
    }
  });
  it('shows global gauges and indicator log entries, and links a CLI turn to its country card', async () => {
    const date = new Date().toISOString().slice(0, 10);
    const startOfMonth = new Date(`${date.slice(0, 7)}-01T00:00:00Z`);
    startOfMonth.setUTCDate(0);
    const period = startOfMonth.toISOString().slice(0, 7);
    const gpr = { date, value: 500, average30d: 300, normal: 180, dailySpike: true, sustainedSpike: true };
    const cli = { period, value: 101, phase: 'expansion', change: 0.3, turningPoint: 'trough' };
    mocks.data = {
      oecdCli: { series: { G20: cli, US: cli } },
      gpr: { latest: gpr, countries: { US: { period, value: 3.8 } }, spikes: [gpr] },
      imfCofer: { latest: { period: '2026-Q2', shares: { USD: 56.7 }, usdYoyPp: -0.24 } },
      pinkSheet: { latest: { period, indices: { energy: { yoyPct: 89.3 }, food: { yoyPct: 14.7 } } },
        spikes: [{ period, key: 'energy', momPct: -12 }] },
    };
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] });
    const { slots, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    try {
      await vi.waitFor(() => expect(slots.telemetry.querySelectorAll('[data-gauge]')).toHaveLength(5));
      expect(slots.telemetry.querySelector('[data-gauge="cofer"]')?.textContent).toContain('56.7%');
      expect(slots.telemetry.querySelector('[data-gauge="gpr"]')?.textContent).toContain('300.0 / 180.0');
      slots.dispatch.querySelector<HTMLButtonElement>('#logToggleBtn')?.click();
      const rows = [...slots.stage.querySelectorAll<HTMLElement>('li[data-kind="global-indicator"]')];
      expect(rows).toHaveLength(4);
      const cliRow = rows.find((row) => row.textContent?.includes('CLI'));
      cliRow?.querySelector('button')?.click();
      expect(slots.stage.querySelectorAll('[data-section="country-indicators"] [data-gauge]')).toHaveLength(2);
      expect(slots.stage.querySelector('[data-section="country-indicators"] [data-gauge="gpr"]')?.textContent).toContain('3.80');
    } finally {
      mounted.destroy();
    }
  });
  it('mounts chrome and reports an empty snapshot', async () => {
    mocks.load.mockResolvedValue({ snapshot: null, archivedDates: [] }); const { slots, map, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} }); await vi.waitFor(() => expect(slots.stage.querySelector('.wfs-status-banner')?.getAttribute('data-state')).toBe('empty'));
    expect(slots.masthead.querySelector('[data-threat="0"]')).not.toBeNull();
    expect(slots.telemetry.querySelector('.wfs-ops-clocks')).not.toBeNull();
    expect(slots.telemetry.querySelectorAll('.bm-counts button')).toHaveLength(3);
    expect(slots.stage.querySelector('.coord-axis-top')).not.toBeNull();
    expect(slots.stage.querySelector('.wfs-ops-event-log')?.getAttribute('data-collapsed')).toBe('true');
    expect(slots.masthead.children.length).toBeGreaterThan(0); expect(slots.dispatch.children.length).toBeGreaterThan(0); expect(slots.shelf.children.length).toBeGreaterThan(0); expect(map.setWorldOverviewMode).toHaveBeenCalledWith(true); mounted.destroy();
    expect(slots.stage.querySelector('.coord-axis-top')).toBeNull();
  });
  it('recovers from a failed impact request and connects dated evidence to the country brief', async () => {
    const at = Date.now() - 3_600_000;
    const link = {
      id: 'tariffs:US:KR', actor: 'US', target: 'KR', kind: 'tariffs', magnitude: 73, direction: 'pressure',
      firstSeen: at, lastSeen: at, trend: 'new', headline: '',
      evidence: [{ title: 'Official tariff determination', publishedAt: at, source: 'Federal Register', url: 'https://example.com/order' }],
    };
    const delayed = { ...link, id: 'conflict:RU:UA', actor: 'RU', target: 'UA', kind: 'conflict', lastSeen: at - 22 * 86_400_000 };
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] });
    mocks.impacts.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({
      generatedAt: at + 1, links: [link, delayed], summary: { today: [link, delayed], byCountry: {} },
      sources: [{ id: 'ucdp', status: 'delayed', dataAsOf: delayed.lastSeen }],
    });
    const { slots, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    try {
      const status = slots.stage.querySelector('.bm-status')!;
      await vi.waitFor(() => expect(status.getAttribute('data-state')).toBe('error'));
      status.querySelector('button')!.click();
      const chip = () => slots.dispatch.querySelector<HTMLButtonElement>('.bm-chip');
      await vi.waitFor(() => expect(chip()?.textContent).toContain('미국 → 대한민국'));
      expect(slots.dispatch.querySelectorAll('.bm-chip')).toHaveLength(1);
      expect(slots.telemetry.querySelector('.bm-sources')?.textContent).toContain('출처 지연 1/1');
      chip()!.click();
      const evidence = slots.stage.querySelector('.bm-link-drawer')!;
      expect(evidence.getAttribute('data-state')).toBe('open');
      expect(evidence.querySelector('a')?.textContent).toBe('Official tariff determination');
      evidence.querySelectorAll<HTMLButtonElement>('.bm-endpoints button')[1]!.click();
      expect(slots.stage.querySelector('[data-section="impact"]')?.textContent).toContain('수신 1');
      expect(slots.stage.querySelector('[data-section="korea-economy"]')).not.toBeNull();
      slots.stage.querySelector<HTMLButtonElement>('[data-section="impact"] [data-impact-id]')!.click();
      expect(evidence.textContent).toContain('대한민국 브리핑');
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
      expect(evidence.getAttribute('data-state')).toBe('closed');
      expect(slots.stage.querySelector('.wfs-country-drawer:not(.bm-link-drawer)')?.getAttribute('data-state')).toBe('open');
    } finally {
      mounted.destroy();
    }
  });
  it('keeps the existing view on errors and shows an error banner', async () => {
    mocks.load.mockResolvedValueOnce({ snapshot, archivedDates: [] }).mockRejectedValueOnce(new Error('offline')); const { slots, map, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    await vi.waitFor(() => expect(slots.shelf.querySelector('[data-date-step="-1"]')).toBeTruthy());
    const calls = map.setWorldOverview.mock.calls;
    const previous = calls[calls.length - 1]?.[0];
    slots.shelf.querySelector<HTMLButtonElement>('[data-date-step="-1"]')!.click();
    await vi.waitFor(() => expect(slots.stage.querySelector('.wfs-status-banner')?.getAttribute('data-state')).toBe('error'));
    expect(calls[calls.length - 1]?.[0]).toBe(previous);
    mounted.destroy();
  });
  it('changes impact kinds, opens country drawer, loads archived dates, and removes listeners', async () => {
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] }); const { slots, ctx } = setup(); const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    await vi.waitFor(() => expect(slots.shelf.querySelector('[data-date-step="-1"]')).toBeTruthy());
    const filter = slots.shelf.querySelector<HTMLButtonElement>('.bm-filters [data-kind="conflict"]')!;
    filter.click();
    expect(filter.getAttribute('aria-pressed')).toBe('false');
    window.dispatchEvent(new CustomEvent('wm:world:country-click', { detail: { code: 'JP' } })); expect(slots.stage.querySelector('.wfs-country-drawer')?.getAttribute('data-state')).toBe('open');
    slots.shelf.querySelector<HTMLButtonElement>('[data-date-step="-1"]')!.click(); await vi.waitFor(() => expect(mocks.load).toHaveBeenCalledWith('2026-11-21'));
    await vi.waitFor(() => expect(slots.stage.querySelector('.bm-status')?.getAttribute('data-state')).toBe('archive'));
    mounted.destroy(); window.dispatchEvent(new CustomEvent('wm:world:country-click', { detail: { code: 'KR' } })); expect(slots.stage.querySelector('.wfs-country-drawer')).toBeNull();
  });
  it('wires counter filters, log toggle, breaking alerts, and lifecycle timers', async () => {
    vi.useFakeTimers();
    mocks.load.mockResolvedValue({ snapshot, archivedDates: [] });
    const { slots, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} });
    await vi.waitFor(() => expect(slots.telemetry.querySelector('.bm-counts')).not.toBeNull());
    slots.telemetry.querySelectorAll<HTMLButtonElement>('.bm-counts button')[1]?.click();
    expect(slots.shelf.querySelector('.bm-windows [aria-pressed="true"]')?.textContent).toBe('24H');
    slots.dispatch.querySelector<HTMLButtonElement>('#logToggleBtn')!.click();
    expect(slots.stage.querySelector('.wfs-ops-event-log')?.getAttribute('data-collapsed')).toBe('false');
    const alert = { id: 'alert-1', headline: '긴급 속보', source: '테스트', threatLevel: 'critical', timestamp: new Date(), origin: 'rss_alert', countryCode: 'KR', corroboration: {} };
    document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: alert }));
    expect(slots.stage.querySelector('.wfs-ops-event-title')?.textContent).toBe('긴급 속보');
    expect(slots.dispatch.querySelector('.bm-breaking')?.textContent).toContain('긴급 속보');
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
