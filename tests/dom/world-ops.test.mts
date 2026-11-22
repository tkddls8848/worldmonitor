import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldClockStrip, WorldEventLog, WorldOpsCounters, WorldThreatBadge } from '@/components/world/WorldOps';
import type { OpsEvent, OpsMetrics } from '@/types/world-overview';

const created: Array<{ destroy?: () => void; element: HTMLElement }> = [];
afterEach(() => {
  for (const component of created.splice(0)) component.destroy?.();
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('world ops components', () => {
  it('renders and clears the threat level and score', () => {
    const badge = new WorldThreatBadge();
    created.push(badge);
    badge.setMetrics({ threatLevel: 2, threatScore: 61, counters: {} as OpsMetrics['counters'] });
    expect(badge.element.dataset.level).toBe('2');
    expect(badge.element.dataset.threat).toBe('2');
    expect(badge.element.querySelectorAll('.wfs-ops-threat-bar')).toHaveLength(5);
    expect(badge.element.querySelector('.wfs-ops-threat-level')?.textContent).toBe('2');
    expect(badge.element.querySelector('.wfs-ops-threat-score')?.textContent).toContain('61');
    expect(badge.element.querySelector('.wfs-ops-threat-label')?.textContent).toBeTruthy();
    badge.setMetrics(null);
    expect(badge.element.hasAttribute('data-level')).toBe(false);
    expect(badge.element.textContent).toContain('—');
  });

  it('shows the six visible counters and uses an em dash for missing data', () => {
    const counters = new WorldOpsCounters();
    created.push(counters);
    expect(counters.element.querySelectorAll('.wfs-ops-counter')).toHaveLength(6);
    expect(counters.element.querySelectorAll('.wfs-ops-counter-value')).toHaveLength(6);
    counters.setCounters({ wars: 1, highConflicts: 2, worsening: 3, sanctionPairs: 4, aiRelations: 5, breaking24h: 6, outages: 7 });
    expect([...counters.element.querySelectorAll('.wfs-ops-counter-value')].map((item) => item.textContent)).toEqual(['1', '2', '3', '4', '5', '7']);
    counters.setCounters(null);
    expect([...counters.element.querySelectorAll('.wfs-ops-counter-value')].every((item) => item.textContent === '—')).toBe(true);
  });

  it('renders six timezone clocks and updates the shared ticker while started', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const clocks = new WorldClockStrip();
    created.push(clocks);
    expect(clocks.element.querySelectorAll('.wfs-ops-clock')).toHaveLength(6);
    clocks.start();
    expect(clocks.element.querySelector('.wfs-ops-clock-time')?.textContent).toBe('00:00');
    vi.advanceTimersByTime(1_000);
    expect(vi.getTimerCount()).toBe(1);
    clocks.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('renders event severity, KST time, country selection, and safe source links', () => {
    const onSelectCountry = vi.fn();
    const log = new WorldEventLog({ onSelectCountry });
    created.push(log);
    const event: OpsEvent = {
      id: 'e1', at: Date.parse('2026-01-01T00:00:00Z'), kind: 'breaking', title: '<img src=x onerror=alert(1)>',
      iso2: 'KR', severity: 'critical', url: 'https://example.com/story',
    };
    log.setEvents([event, { ...event, id: 'outage', kind: 'outage', title: '인터넷 차단' }]);
    const row = log.element.querySelector('.wfs-ops-event');
    expect(row?.querySelector('[data-severity="critical"]')).not.toBeNull();
    expect(row?.querySelector('time')?.textContent).toBe('09:00');
    expect(row?.querySelector('.wfs-ops-event-title')?.textContent).toBe(event.title);
    expect(row?.querySelector('img')).toBeNull();
    const link = row?.querySelector('a');
    expect(link?.target).toBe('_blank');
    expect(link?.rel).toBe('noopener noreferrer');
    expect(log.element.querySelector('[data-kind="outage"]')).not.toBeNull();
    (row?.querySelector('button') as HTMLButtonElement).click();
    expect(onSelectCountry).toHaveBeenCalledWith('KR');
    log.setEvents([]);
    expect(log.element.textContent).toContain('기록된 이벤트가 없습니다');
  });
});
