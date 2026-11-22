import type { OpsCounters, OpsEvent, OpsMetrics, ThreatLevel } from '@/types/world-overview';
import { THREAT_LEVEL_LABEL_KO } from '@/services/world-ops';
import '@/styles/world-ops.css';

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, value?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (value !== undefined) element.textContent = value;
  return element;
}

export class WorldThreatBadge {
  readonly element = node('section', 'wfs-ops-threat');
  private readonly level = node('strong', 'wfs-ops-threat-level');
  private readonly label = node('span', 'wfs-ops-threat-label');
  private readonly score = node('span', 'wfs-ops-threat-score');

  constructor() {
    this.element.setAttribute('aria-label', '세계 위협 수준');
    this.element.append(this.level, this.label, this.score);
    this.setMetrics(null);
  }

  setMetrics(metrics: OpsMetrics | null): void {
    if (!metrics) {
      this.element.removeAttribute('data-level');
      this.level.textContent = '—';
      this.label.textContent = '위협 정보 없음';
      this.score.textContent = '';
      return;
    }
    this.element.dataset.level = String(metrics.threatLevel);
    this.level.textContent = String(metrics.threatLevel);
    this.label.textContent = THREAT_LEVEL_LABEL_KO[metrics.threatLevel];
    this.score.textContent = `점수 ${metrics.threatScore}`;
  }
}

const COUNTER_FIELDS: ReadonlyArray<{ key: keyof OpsCounters; label: string }> = [
  { key: 'wars', label: '전쟁' },
  { key: 'highConflicts', label: '고강도 충돌' },
  { key: 'worsening', label: '악화 관계' },
  { key: 'sanctionPairs', label: '제재 쌍' },
  { key: 'aiRelations', label: 'AI 관계' },
  { key: 'breaking24h', label: '24시간 속보' },
];

export class WorldOpsCounters {
  readonly element = node('dl', 'wfs-ops-counters');
  private readonly values = new Map<keyof OpsCounters, HTMLElement>();

  constructor() {
    for (const counter of COUNTER_FIELDS) {
      const group = node('div', 'wfs-ops-counter');
      const value = node('dd', 'wfs-ops-counter-value', '—');
      group.append(node('dt', 'wfs-ops-counter-label', counter.label), value);
      this.values.set(counter.key, value);
      this.element.append(group);
    }
  }

  setCounters(counters: OpsCounters | null): void {
    for (const { key } of COUNTER_FIELDS) {
      const value = this.values.get(key);
      if (value) value.textContent = counters ? String(counters[key]) : '—';
    }
  }
}

const CLOCKS: ReadonlyArray<{ label: string; zone: string }> = [
  { label: 'UTC', zone: 'UTC' },
  { label: '서울', zone: 'Asia/Seoul' },
  { label: '뉴욕', zone: 'America/New_York' },
  { label: '브뤼셀', zone: 'Europe/Brussels' },
  { label: '베이징', zone: 'Asia/Shanghai' },
  { label: '모스크바', zone: 'Europe/Moscow' },
];

const clockSubscribers = new Set<() => void>();
let clockInterval: ReturnType<typeof setInterval> | null = null;
function tickClocks(): void {
  for (const update of clockSubscribers) update();
}
function syncClockTicker(): void {
  if (clockSubscribers.size && !document.hidden && clockInterval === null) {
    tickClocks();
    clockInterval = setInterval(tickClocks, 1_000);
  } else if ((!clockSubscribers.size || document.hidden) && clockInterval !== null) {
    clearInterval(clockInterval);
    clockInterval = null;
  }
}
document.addEventListener('visibilitychange', syncClockTicker);

export class WorldClockStrip {
  readonly element = node('div', 'wfs-ops-clocks');
  private readonly displays = CLOCKS.map(({ label, zone }) => {
    const item = node('div', 'wfs-ops-clock');
    const time = node('time', 'wfs-ops-clock-time', '--:--');
    item.append(node('span', 'wfs-ops-clock-label', label), time);
    this.element.append(item);
    return { zone, time };
  });
  private running = false;
  private readonly update = (): void => {
    const now = Date.now();
    for (const { zone, time } of this.displays) {
      const formatted = new Intl.DateTimeFormat('en-GB', {
        timeZone: zone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).format(now);
      time.textContent = formatted;
      time.dateTime = new Date(now).toISOString();
      time.setAttribute('aria-label', `${zone} ${formatted}`);
    }
  };

  start(): void {
    if (this.running) return;
    this.running = true;
    clockSubscribers.add(this.update);
    syncClockTicker();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    clockSubscribers.delete(this.update);
    syncClockTicker();
  }

  destroy(): void {
    this.stop();
    this.element.remove();
  }
}

function eventTime(at: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(at);
}

export class WorldEventLog {
  readonly element = node('section', 'wfs-ops-event-log');
  private readonly list = node('ol', 'wfs-ops-event-list');

  constructor(private readonly callbacks: { onSelectCountry(iso2: string): void }) {
    this.element.setAttribute('aria-label', '실시간 이벤트 기록');
    this.element.append(this.list);
    this.setEvents([]);
  }

  setEvents(events: OpsEvent[]): void {
    this.list.replaceChildren();
    if (!events.length) {
      this.list.append(node('li', 'wfs-ops-event-empty', '기록된 이벤트가 없습니다'));
      return;
    }
    for (const event of events) {
      const row = node('li', 'wfs-ops-event');
      const mark = node('span', 'wfs-ops-event-mark');
      mark.dataset.severity = event.severity;
      mark.setAttribute('aria-label', event.severity);
      const time = node('time', 'wfs-ops-event-time', eventTime(event.at));
      time.dateTime = new Date(event.at).toISOString();
      const title = node('span', 'wfs-ops-event-title', event.title);
      row.append(mark, time, title);
      if (event.iso2) {
        const country = node('button', 'wfs-ops-event-country', event.iso2);
        country.type = 'button';
        country.setAttribute('aria-label', `${event.iso2} 국가 보기`);
        country.addEventListener('click', () => this.callbacks.onSelectCountry(event.iso2!));
        row.append(country);
      }
      const sourceUrl = event.url ? safeSourceUrl(event.url) : null;
      if (sourceUrl) {
        const link = node('a', 'wfs-ops-event-link');
        link.href = sourceUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.setAttribute('aria-label', '출처 열기 (새 탭)');
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('viewBox', '0 0 16 16');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('focusable', 'false');
        icon.classList.add('wfs-ops-event-link-icon');
        const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        path.setAttribute('d', 'M5 3h8v8M13 3 6 10M11 9v4H3V5h4');
        path.setAttribute('fill', 'none');
        path.setAttribute('stroke', 'currentColor');
        path.setAttribute('stroke-width', '1.5');
        icon.append(path);
        link.append(icon);
        row.append(link);
      }
      this.list.append(row);
    }
  }

  destroy(): void {
    this.element.remove();
  }
}

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value, document.baseURI);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

export type { ThreatLevel };
