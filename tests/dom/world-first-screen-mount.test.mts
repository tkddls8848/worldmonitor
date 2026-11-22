import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ load: vi.fn(), mark: vi.fn(), fields: ['military', 'geopolitics'] as string[], setFields: vi.fn(), data: {} as Record<string, unknown> }));
vi.mock('@/services/world-overview', () => ({ loadWorldOverview: mocks.load, setWorldMark: mocks.mark }));
vi.mock('@/services/world-overview-view', () => ({ buildWorldMapView: vi.fn((_s, _f, selected) => ({ date: '2026-11-22', countries: {}, lines: [], blocOutlines: [], selectedIso2: selected, relatedIso2: [] })), buildCountryDrawerData: vi.fn((_s, iso2) => ({ iso2, nameKo: iso2, nameEn: iso2, level: null, conflictLevel: null, ciiScore: null, updatedAt: 1, issue: null, relations: [], blocs: [], isToday: true, aiStatus: 'ok' })) }));
vi.mock('@/services/world-first-screen-prefs', () => ({ getWorldFields: () => [...mocks.fields], setWorldFields: mocks.setFields }));
vi.mock('@/services/world-ticker', () => ({ loadTickerItems: vi.fn(() => Promise.resolve([])) }));
vi.mock('@/services/country-geometry', () => ({ preloadCountryGeometry: vi.fn(() => new Promise(() => { /* geometry never needed here */ })) }));
import { mountWorldFirstScreen } from '../../src/app/world-first-screen';

const snapshot = { date: '2026-11-22', availableDates: ['2026-11-21', '2026-11-22'], countries: {}, relations: [], anchors: {}, blocs: [], ai: { status: 'ok' }, generatedAt: 1 } as never;
function setup() {
  const root = document.createElement('div'); const slots = Object.fromEntries(['masthead', 'telemetry', 'dispatch', 'stage', 'shelf'].map((key) => { const node = document.createElement('div'); node.dataset.slot = key; root.append(node); return [key, node]; })) as Record<string, HTMLElement>;
  const map = { setWorldOverviewMode: vi.fn(), setWorldOverview: vi.fn(), onWorldLineClicked: vi.fn(), zoomBy: vi.fn(), resetWorldView: vi.fn(), setCenter: vi.fn() };
  document.body.append(root);
  const ctx = { map } as never;
  return { root, slots: { root, ...slots }, map, ctx };
}
afterEach(() => { document.body.replaceChildren(); vi.clearAllMocks(); mocks.fields = ['military', 'geopolitics']; mocks.data = {}; });

describe('mountWorldFirstScreen', () => {
  it('mounts chrome and reports an empty snapshot', async () => {
    mocks.load.mockResolvedValue({ snapshot: null, archivedDates: [] }); const { slots, map, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} }); await vi.waitFor(() => expect(slots.stage.querySelector('.wfs-status-banner')?.getAttribute('data-state')).toBe('empty'));
    expect(slots.masthead.querySelector('[data-threat="0"]')).not.toBeNull();
    expect(slots.telemetry.querySelector('.wfs-ops-clocks')).not.toBeNull();
    expect(slots.telemetry.querySelectorAll('.wfs-ops-counter-btn')).toHaveLength(5);
    expect(slots.stage.querySelector('.coord-axis-top')).not.toBeNull();
    expect(slots.stage.querySelector('.wfs-ops-event-log')?.getAttribute('data-collapsed')).toBe(String(window.innerWidth <= 1440));
    expect(slots.masthead.children.length).toBeGreaterThan(0); expect(slots.dispatch.children.length).toBeGreaterThan(0); expect(slots.shelf.children.length).toBeGreaterThan(0); expect(map.setWorldOverviewMode).toHaveBeenCalledWith(true); mounted.destroy();
    expect(slots.stage.querySelector('.coord-axis-top')).toBeNull();
  });
  it('keeps the existing view on errors and shows an error banner', async () => {
    mocks.load.mockResolvedValueOnce({ snapshot, archivedDates: [] }).mockRejectedValueOnce(new Error('offline')); const { slots, map, ctx } = setup();
    const mounted = mountWorldFirstScreen(ctx, slots, { openFullView() {}, openCountryBrief() {} }); await vi.waitFor(() => expect(map.setWorldOverview).toHaveBeenCalled()); const previous = map.setWorldOverview.mock.calls.at(-1)?.[0];
    slots.shelf.querySelector<HTMLButtonElement>('[data-date-step="-1"]')!.click();
    await vi.waitFor(() => expect(slots.stage.querySelector('.wfs-status-banner')?.getAttribute('data-state')).toBe('error')); expect(map.setWorldOverview.mock.calls.at(-1)?.[0]).toBe(previous); mounted.destroy();
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
});
