import type { OpsCounters, OpsEvent, OpsMetrics, ThreatLevel } from '@/types/world-overview';
import { THREAT_LEVEL_LABEL_KO } from '@/services/world-ops';
import { getCurrentLanguage } from '@/services/i18n';
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
  private readonly bars = node('span', 'wfs-ops-threat-bars');
  private readonly status = node('span', 'wfs-ops-threat-status');

  constructor() {
    this.element.setAttribute('aria-label', '세계 위협 수준');
    this.element.classList.add('threat-badge');
    this.element.append(this.level, this.label, this.bars, this.score, this.status);
    for (let index = 0; index < 5; index++) this.bars.append(node('i', 'wfs-ops-threat-bar'));
    this.setMetrics(null);
  }

  setMetrics(metrics: OpsMetrics | null): void {
    if (!metrics) {
      this.element.removeAttribute('data-level');
      this.element.dataset.threat = '0';
      this.element.style.setProperty('--ops-lit-width', '0px');
      this.level.textContent = '—';
      this.label.textContent = '';
      this.score.textContent = '';
      this.status.textContent = this.status.textContent === '수신 오류' ? '수신 오류' : '산출 대기';
      return;
    }
    this.element.dataset.level = String(metrics.threatLevel);
    this.element.dataset.threat = String(metrics.threatLevel);
    this.element.style.removeProperty('--ops-lit-width');
    this.element.style.removeProperty('--ops-threat-color');
    this.level.textContent = String(metrics.threatLevel);
    this.label.textContent = THREAT_LEVEL_LABEL_KO[metrics.threatLevel];
    this.score.textContent = `점수 ${metrics.threatScore}`;
    this.status.textContent = '';
  }
  setError(): void {
    this.setMetrics(null);
    this.element.style.setProperty('--ops-threat-color', 'var(--ops-threat-1)');
    this.status.textContent = '수신 오류';
  }
}

const COUNTER_FIELDS: ReadonlyArray<{ key: keyof OpsCounters; label: string }> = [
  { key: 'wars', label: '진행 전쟁' },
  { key: 'highConflicts', label: '고위험국' },
  { key: 'worsening', label: '악화 관계' },
  { key: 'sanctionPairs', label: '제재 쌍' },
  { key: 'aiRelations', label: 'AI 감지' },
  { key: 'outages', label: '인터넷 차단' },
];

export class WorldOpsCounters {
  readonly element = node('dl', 'wfs-ops-counters ops-counters');
  private readonly values = new Map<keyof OpsCounters, HTMLElement>();

  constructor(private readonly onSelect?: (key: keyof OpsCounters, button: HTMLButtonElement) => void) {
    for (const counter of COUNTER_FIELDS) {
      const group = node('div', 'wfs-ops-counter');
      const button = node('button', 'wfs-ops-counter-btn ops-counter-btn');
      button.type = 'button';
      button.dataset.counter = counter.key;
      const label = node('span', 'wfs-ops-counter-label', counter.label);
      const value = node('span', 'wfs-ops-counter-value', '—');
      button.append(label, value);
      button.addEventListener('click', () => this.onSelect?.(counter.key, button));
      group.append(button);
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
  setActive(key: keyof OpsCounters | null): void {
    for (const button of this.element.querySelectorAll<HTMLButtonElement>('.wfs-ops-counter-btn')) {
      button.classList.toggle('is-active', button.dataset.counter === key);
      button.setAttribute('aria-pressed', String(button.dataset.counter === key));
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
let visibilityListenerInstalled = false;
function tickClocks(): void {
  for (const update of clockSubscribers) update();
}
function syncClockTicker(): void {
  if (clockSubscribers.size && !visibilityListenerInstalled) {
    document.addEventListener('visibilitychange', syncClockTicker);
    visibilityListenerInstalled = true;
  } else if (!clockSubscribers.size && visibilityListenerInstalled) {
    document.removeEventListener('visibilitychange', syncClockTicker);
    visibilityListenerInstalled = false;
  }
  if (clockSubscribers.size && !document.hidden && clockInterval === null) {
    tickClocks();
    clockInterval = setInterval(tickClocks, 1_000);
  } else if ((!clockSubscribers.size || document.hidden) && clockInterval !== null) {
    clearInterval(clockInterval);
    clockInterval = null;
  }
}

export class WorldClockStrip {
  readonly element = node('div', 'wfs-ops-clocks clock-strip');
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

const AUCTION_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
});

export function federalRegisterPrePublicationLabel(): string {
  return getCurrentLanguage() === 'ko' ? '사전 공개' : 'Pre-publication';
}

export class WorldEventLog {
  readonly element = node('section', 'wfs-ops-event-log ops-log-rail');
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
      row.dataset.kind = event.kind;
      const mark = node('span', 'wfs-ops-event-mark');
      mark.dataset.severity = event.severity;
      mark.dataset.kind = event.kind;
      mark.setAttribute('aria-label', event.severity);
      const timestamp = new Date(event.at).toISOString();
      const publicationDay = event.kind === 'federal-register'
        ? event.scheduledPublicationDate ?? timestamp.slice(0, 10)
        : undefined;
      const displayDay = event.kind === 'treasury-auction' ? AUCTION_DAY.format(event.at) : publicationDay;
      const time = node('time', 'wfs-ops-event-time', displayDay ? displayDay.slice(5) : eventTime(event.at));
      time.dateTime = publicationDay ?? timestamp;
      const title = node('span', 'wfs-ops-event-title', event.title);
      row.append(mark, time);
      if (event.scheduledPublicationDate) {
        const summary = node('span', 'wfs-ops-event-summary');
        summary.append(node('span', 'wfs-ops-event-publication', federalRegisterPrePublicationLabel()), title);
        summary.title = event.title;
        row.append(summary);
      } else {
        row.append(title);
      }
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
