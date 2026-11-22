import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldMasthead, WorldDispatchBar, WorldKeyPlate, WorldBottomShelf, WorldStatusBanner } from '../../src/components/world/WorldChrome';

afterEach(() => { document.body.replaceChildren(); vi.useRealTimers(); });

describe('world screen chrome', () => {
  it('renders ticker values, direction and missing-value dash', () => {
    const masthead = new WorldMasthead({ onToggleTheme() {}, onOpenFullView() {}, onTickerClick() {} });
    masthead.setTickerItems(Array.from({ length: 8 }, (_, i) => ({ id: `${i}`, label: `M${i}`, value: i ? 1 : null, changePct: i === 1 ? 2 : i === 2 ? -1 : null, digits: 0 })));
    expect(masthead.element.querySelectorAll('.wfs-ticker-item')).toHaveLength(8);
    expect(masthead.element.textContent).toContain('—');
    expect(masthead.element.querySelector('.is-up')).toBeTruthy();
    expect(masthead.element.querySelector('.is-down')).toBeTruthy();
    masthead.destroy();
  });
  it('keeps the last breaking alert and locates it', () => {
    const onLocate = vi.fn(); const bar = new WorldDispatchBar({ onLocate }); document.body.append(bar.element);
    const alert = { id: 'a', headline: 'Alert headline', source: 'Wire', threatLevel: 'high', timestamp: new Date(), origin: 'rss_alert', corroboration: {} } as never;
    document.dispatchEvent(new CustomEvent('wm:breaking-news', { detail: alert }));
    expect(bar.element.textContent).toContain('Alert headline');
    bar.element.querySelector<HTMLButtonElement>('.wfs-locate')!.click(); expect(onLocate).toHaveBeenCalledWith(alert);
    bar.destroy();
  });
  it('toggles fields and steps/clamps dates; timelapse stops at the end', () => {
    vi.useFakeTimers(); const onFieldsChange = vi.fn(), onDateChange = vi.fn();
    const shelf = new WorldBottomShelf({ onFieldsChange, onDateChange }); document.body.append(shelf.element);
    shelf.setFields([]); shelf.element.querySelector<HTMLButtonElement>('[data-field="military"]')!.click();
    expect(onFieldsChange).toHaveBeenLastCalledWith(['military']);
    shelf.setDates(['2026-11-20', '2026-11-21'], '2026-11-20');
    shelf.element.querySelector<HTMLButtonElement>('[data-date-step="1"]')!.click(); expect(onDateChange).toHaveBeenLastCalledWith('2026-11-21');
    shelf.element.querySelector<HTMLButtonElement>('.wfs-timelapse')!.click(); vi.advanceTimersByTime(1200);
    expect(onDateChange).toHaveBeenLastCalledWith('2026-11-21'); expect(shelf.element.querySelector('.wfs-timelapse')!.textContent).toContain('재생');
    shelf.destroy();
  });
  it('shows only line kinds for enabled fields and status states', () => {
    const key = new WorldKeyPlate(); key.setFields(['military']); expect(key.element.textContent).not.toContain('동맹');
    const status = new WorldStatusBanner(); status.setState('loading'); expect(status.element.textContent).toContain('불러오는');
    status.setState('empty'); expect(status.element.textContent).toContain('데이터 없음');
    status.setState('error', '연결 오류'); expect(status.element.textContent).toContain('연결 오류');
    status.setState('ok'); expect(status.element.hidden).toBe(true);
  });
});
