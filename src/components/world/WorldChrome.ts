import type { BreakingAlert } from '@/services/breaking-news-alerts';
import type { TickerItem, WorldField, WorldLoadState } from '@/types/world-overview';
import { FIELD_LABEL_KO, WORLD_FIELDS } from '../../../shared/world-overview.js';
import css from '@/styles/world-first-screen.css?inline';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

let styleInstalled = false;
function installStyle(): void {
  if (styleInstalled || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.dataset.wfsStyles = 'true';
  style.textContent = css;
  document.head.append(style);
  styleInstalled = true;
}
function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function icon(name: 'sun' | 'moon' | 'plus' | 'minus' | 'reset' | 'warning'): string {
  const paths: Record<string, string> = {
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/>',
    moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>',
    plus: '<path d="M12 5v14m-7-7h14"/>',
    minus: '<path d="M5 12h14"/>',
    reset: '<path d="M3 12a9 9 0 1 0 2.64-6.36L3 8"/><path d="M3 3v5h5"/>',
    warning: '<path d="m12 3 10 18H2L12 3Z"/><path d="M12 9v5m0 3h.01"/>',
  };
  return `<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths[name]}</svg>`;
}

export class WorldMasthead {
  readonly element: HTMLElement;
  private ticker = el('div', 'wfs-ticker');
  constructor(private callbacks: { onToggleTheme(): void; onOpenFullView(): void; onTickerClick(id: string): void }) {
    installStyle();
    this.element = el('header', 'masthead-bar');
    const brand = el('div', 'wfs-brand');
    brand.append(el('strong', '', 'WorldMonitor'), el('span', '', 'GLOBAL INTELLIGENCE'));
    const threatMount = el('div', 'wfs-threat-mount');
    threatMount.dataset.slot = 'threat';
    const theme = el('button', 'wfs-icon-button', '');
    theme.type = 'button';
    theme.setAttribute('aria-label', '테마 전환');
    setTrustedHtml(theme, trustedHtml(icon('moon'), 'static inline SVG icon'));
    theme.addEventListener('click', callbacks.onToggleTheme);
    const full = el('button', 'wfs-full-view', '전체 보기');
    full.type = 'button';
    full.addEventListener('click', callbacks.onOpenFullView);
    this.element.append(brand, threatMount, this.ticker, theme, full);
  }
  setTickerItems(items: TickerItem[]): void {
    this.ticker.replaceChildren();
    if (!items.length) {
      this.ticker.append(el('span', 'wfs-empty', '표시할 시세 지표가 없습니다'));
      return;
    }
    for (const item of items) {
      const control = item.url ? el('a', 'wfs-ticker-item') : el('button', 'wfs-ticker-item');
      const display = item.displayValue ?? (item.value === null ? '—' : `${item.value.toFixed(item.digits)}${item.unit ?? ''}`);
      control.dataset.ticker = item.id;
      if (control instanceof HTMLAnchorElement && item.url) {
        control.href = item.url;
        control.target = '_blank';
        control.rel = 'noopener noreferrer';
      } else if (control instanceof HTMLButtonElement) {
        control.type = 'button';
        control.addEventListener('click', () => this.callbacks.onTickerClick(item.id));
      }
      control.setAttribute('aria-label', `${item.label}: ${display}`);
      const label = el('span', 'wfs-ticker-label', item.label),
        value = el('strong', 'num', display);
      if (item.changePct !== null) {
        const adverse = item.inverse ? -item.changePct : item.changePct;
        const suffix = item.changeKind === 'bp' ? ' bp' : item.changeKind === 'abs' ? '' : '%';
        const change = el(
          'span',
          `wfs-ticker-change ${adverse > 0 ? 'is-down' : adverse < 0 ? 'is-up' : ''}`,
          `${item.changePct > 0 ? '+' : ''}${item.changePct.toFixed(item.changeKind === 'bp' ? 0 : 2)}${suffix}`,
        );
        control.append(label, value, change);
      } else control.append(label, value);
      this.ticker.append(control);
    }
  }
  destroy(): void {
    this.element.remove();
  }
}

export class WorldDispatchBar {
  readonly element: HTMLElement;
  private alerts: BreakingAlert[] = [];
  private index = 0;
  private badge = el('span', 'wfs-alert-badge', '속보');
  private headline = el('span', 'wfs-dispatch-headline', '선택한 날짜와 분야 조건에 해당하는 속보가 없습니다.');
  private meta = el('span', 'wfs-dispatch-time');
  private locate = el('button', 'wfs-locate', '지도 이동');
  private prev = el('button', 'wfs-page', '‹');
  private next = el('button', 'wfs-page', '›');
  private logToggle = el('button', 'wfs-log-toggle ops-log-toggle', '로그');
  private listener = (event: Event) => {
    const alert = (event as CustomEvent<BreakingAlert>).detail;
    if (!alert) return;
    this.alerts = [...this.alerts, alert].slice(-10);
    this.index = this.alerts.length - 1;
    this.render();
  };
  constructor(private callbacks: { onLocate(alert: BreakingAlert): void; onToggleLog?(): void }) {
    installStyle();
    this.element = el('section', 'dispatch-bar');
    this.element.setAttribute('aria-label', '속보');
    for (const button of [this.prev, this.next]) button.type = 'button';
    this.locate.type = 'button';
    this.logToggle.type = 'button';
    this.logToggle.id = 'logToggleBtn';
    this.logToggle.setAttribute('aria-expanded', 'false');
    this.logToggle.addEventListener('click', () => callbacks.onToggleLog?.());
    this.prev.setAttribute('aria-label', '이전 속보');
    this.next.setAttribute('aria-label', '다음 속보');
    this.prev.addEventListener('click', () => {
      this.index = Math.max(0, this.index - 1);
      this.render();
    });
    this.next.addEventListener('click', () => {
      this.index = Math.min(this.alerts.length - 1, this.index + 1);
      this.render();
    });
    this.locate.addEventListener('click', () => {
      const alert = this.alerts[this.index];
      if (alert) this.callbacks.onLocate(alert);
    });
    this.element.append(this.badge, this.headline, this.meta, this.locate, this.prev, this.next, this.logToggle);
    document.addEventListener('wm:breaking-news', this.listener);
  }
  setLogState(open: boolean, count: number): void {
    this.logToggle.replaceChildren(document.createTextNode('로그 '));
    const countBadge = el('span', 'wfs-log-count', String(count));
    countBadge.setAttribute('aria-label', `이벤트 ${count}개`);
    this.logToggle.append(countBadge);
    this.logToggle.setAttribute('aria-expanded', String(open));
  }
  private render(): void {
    const alert = this.alerts[this.index];
    this.headline.textContent = alert?.headline ?? '선택한 날짜와 분야 조건에 해당하는 속보가 없습니다.';
    this.meta.textContent = alert
      ? `${alert.source} · ${new Intl.DateTimeFormat('ko-KR', { hour: '2-digit', minute: '2-digit' }).format(alert.timestamp)}`
      : '';
    this.locate.hidden = !alert;
    this.prev.disabled = this.index <= 0;
    this.next.disabled = this.index >= this.alerts.length - 1;
  }
  destroy(): void {
    document.removeEventListener('wm:breaking-news', this.listener);
    this.element.remove();
  }
}

const fieldKinds: Partial<Record<WorldField, string[]>> = {
  military: ['지원'],
  diplomacy: ['동맹'],
  geopolitics: ['긴장'],
  politics: [],
  finance: ['제재', '경제 의존'],
};
export class WorldKeyPlate {
  readonly element: HTMLElement;
  private fields: readonly WorldField[] = WORLD_FIELDS;
  constructor() {
    installStyle();
    this.element = el('aside', 'atlas-key-plate');
    this.render();
  }
  setFields(fields: readonly WorldField[]): void {
    this.fields = fields;
    this.render();
  }
  private render(): void {
    this.element.replaceChildren();
    const title = el('strong', 'wfs-key-title');
    title.append(el('span', '', '지도 범례'));
    if (this.fields.includes('military')) title.append(el('small', '', 'CII'));
    this.element.append(title);
    if (this.fields.includes('military')) {
      const levels = ['평온', '관심', '주의', '경계', '고위험'];
      const scale = el('div', 'wfs-cii-scale');
      levels.forEach((label, i) => {
        const chip = el('span', 'wfs-cii-step', label);
        chip.dataset.level = String(i);
        scale.append(chip);
      });
      this.element.append(scale);
    }
    const lines = el('div', 'wfs-line-legend');
    const kinds = new Set(this.fields.flatMap((f) => fieldKinds[f] ?? []));
    for (const k of kinds) {
      const item = el('span', 'wfs-line-key', k);
      item.dataset.kind = k;
      lines.append(item);
    }
    if (kinds.size) this.element.append(lines);
  }
}

export class WorldZoomControls {
  readonly element: HTMLElement;
  constructor(callbacks: { onZoomIn(): void; onZoomOut(): void; onReset(): void }) {
    installStyle();
    this.element = el('div', 'zoom-controls');
    for (const [label, name, cb] of [
      ['확대', 'plus', callbacks.onZoomIn],
      ['축소', 'minus', callbacks.onZoomOut],
      ['초기화', 'reset', callbacks.onReset],
    ] as const) {
      const b = el('button', 'wfs-zoom-button');
      b.type = 'button';
      b.setAttribute('aria-label', label);
      setTrustedHtml(b, trustedHtml(icon(name), 'static inline SVG icon'));
      b.addEventListener('click', cb);
      this.element.append(b);
    }
  }
}

export class WorldBottomShelf {
  readonly element: HTMLElement;
  private fields: WorldField[] = [...WORLD_FIELDS];
  private dates: string[] = [];
  private current = '';
  private timer: ReturnType<typeof setInterval> | null = null;
  private fieldBar = el('div', 'wfs-domain-tabs');
  private timeline = el('div', 'wfs-timeline');
  private play = el('button', 'wfs-timelapse', '타임랩스 재생');
  private range = el('input', 'wfs-date-range');
  private dateInput = el('input', 'wfs-date-input');
  private dateLabel = el('output', 'wfs-current-date');
  constructor(private callbacks: { onFieldsChange(fields: WorldField[]): void; onDateChange(date: string): void }) {
    installStyle();
    this.element = el('footer', 'bottom-shelf');
    this.play.type = 'button';
    this.range.type = 'range';
    this.range.min = '0';
    this.range.step = '1';
    this.dateInput.type = 'date';
    this.play.addEventListener('click', () => this.togglePlay());
    this.range.addEventListener('input', () => this.selectIndex(Number(this.range.value)));
    this.dateInput.addEventListener('change', () => {
      if (this.dates.includes(this.dateInput.value)) this.select(this.dateInput.value);
      else this.dateInput.value = this.current;
    });
    this.element.append(this.fieldBar, this.timeline);
    this.renderFields();
  }
  setFields(fields: readonly WorldField[]): void {
    this.fields = [...fields];
    this.renderFields();
  }
  private renderFields(): void {
    this.fieldBar.replaceChildren();
    for (const field of WORLD_FIELDS) {
      const b = el('button', `domain-tab ${this.fields.includes(field) ? 'active' : ''}`, FIELD_LABEL_KO[field]);
      b.type = 'button';
      b.dataset.field = field;
      b.setAttribute('aria-pressed', String(this.fields.includes(field)));
      b.addEventListener('click', () => {
        this.fields = this.fields.includes(field) ? this.fields.filter((f) => f !== field) : [...this.fields, field];
        this.renderFields();
        this.callbacks.onFieldsChange([...this.fields]);
      });
      this.fieldBar.append(b);
    }
  }
  setDates(available: string[], current: string): void {
    this.stop();
    this.dates = [...new Set(available)].sort();
    this.current = this.dates.includes(current) ? current : (this.dates[this.dates.length - 1] ?? '');
    this.renderDates();
  }
  private renderDates(): void {
    this.timeline.replaceChildren();
    if (!this.dates.length) {
      this.dateLabel.textContent = '날짜 없음';
      this.timeline.append(this.dateLabel);
      return;
    }
    this.range.max = String(this.dates.length - 1);
    this.range.value = String(Math.max(0, this.dates.indexOf(this.current)));
    this.dateInput.min = this.dates[0] ?? '';
    this.dateInput.max = this.dates[this.dates.length - 1] ?? '';
    this.dateInput.value = this.current;
    this.dateLabel.textContent = this.current;
    const prev = el('button', 'wfs-date-step', '‹'),
      next = el('button', 'wfs-date-step', '›');
    prev.type = next.type = 'button';
    prev.dataset.dateStep = '-1';
    next.dataset.dateStep = '1';
    prev.setAttribute('aria-label', '이전 날짜');
    next.setAttribute('aria-label', '다음 날짜');
    prev.disabled = this.dates.indexOf(this.current) <= 0;
    next.disabled = this.dates.indexOf(this.current) >= this.dates.length - 1;
    prev.addEventListener('click', () => this.selectIndex(this.dates.indexOf(this.current) - 1));
    next.addEventListener('click', () => this.selectIndex(this.dates.indexOf(this.current) + 1));
    this.play.textContent = this.timer ? '타임랩스 정지' : '타임랩스 재생';
    this.timeline.append(this.play, prev, this.range, this.dateLabel, next, this.dateInput);
  }
  private selectIndex(index: number): void {
    if (!this.dates.length) return;
    this.select(this.dates[Math.max(0, Math.min(this.dates.length - 1, index))] ?? '');
  }
  private select(date: string): void {
    if (date === this.current) return;
    this.current = date;
    this.renderDates();
    this.callbacks.onDateChange(date);
  }
  private togglePlay(): void {
    if (this.timer) {
      this.stop();
      this.renderDates();
      return;
    }
    if (this.dates.indexOf(this.current) >= this.dates.length - 1) return;
    this.timer = setInterval(() => {
      const i = this.dates.indexOf(this.current);
      if (i >= this.dates.length - 1) {
        this.stop();
        this.renderDates();
        return;
      }
      this.selectIndex(i + 1);
      if (this.dates.indexOf(this.current) >= this.dates.length - 1) {
        this.stop();
        this.renderDates();
      }
    }, 1200);
    this.renderDates();
  }
  private stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  destroy(): void {
    this.stop();
    this.element.remove();
  }
}

export class WorldStatusBanner {
  readonly element: HTMLElement;
  constructor() {
    installStyle();
    this.element = el('div', 'wfs-status-banner');
    this.element.setAttribute('role', 'status');
    this.element.hidden = true;
  }
  setState(state: WorldLoadState, detail?: string): void {
    this.element.replaceChildren();
    if (state === 'ok') {
      this.element.hidden = true;
      return;
    }
    this.element.hidden = false;
    const copy: Record<Exclude<WorldLoadState, 'ok'>, string> = {
      loading: '세계 현황 데이터를 불러오는 중입니다.',
      empty: '데이터 없음 · 세계 현황 자료가 아직 수집되지 않았습니다.',
      error: detail || '데이터를 불러오지 못했습니다. 다시 시도해 주세요.',
    };
    if (state === 'error') setTrustedHtml(this.element, trustedHtml(icon('warning'), 'static inline SVG icon'));
    else this.element.replaceChildren();
    this.element.append(document.createTextNode(copy[state]));
    this.element.dataset.state = state;
  }
}
