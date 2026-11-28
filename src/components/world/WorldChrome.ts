import type { BreakingAlert } from '@/services/breaking-news-alerts';
import type { FillLevel, RelationKind, TickerItem, WorldField, WorldLoadState } from '@/types/world-overview';
import { WORLD_BLOC_COLORS, WORLD_FILL_COLORS, WORLD_HOTSPOT_COLORS, WORLD_UNREST_OUTLINE } from '@/config/world-overview-palette';
import { FIELD_LABEL_KO, KIND_LABEL_KO, WORLD_FIELDS } from '../../../shared/world-overview.js';
import css from '@/styles/world-first-screen.css?inline';
import battleCss from '@/styles/battle-map.css?inline';
import { IMPACT_STYLES } from '@/config/battle-map';
import { setTrustedHtml, trustedHtml } from '@/utils/dom-utils';

let styleInstalled = false;
function installStyle(): void {
  if (styleInstalled || typeof document === 'undefined') return;
  const style = document.createElement('style');
  style.dataset.wfsStyles = 'true';
  const kindColors = (theme: 'dark' | 'light') => Object.entries(IMPACT_STYLES)
    .map(([kind, value]) => `--bm-kind-${kind}:${value[theme]};`).join('');
  style.textContent = css + battleCss + `.battle-map{${kindColors('light')}}:root[data-theme="dark"] .battle-map{${kindColors('dark')}}`;
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
    this.ticker.tabIndex = 0;
    this.ticker.setAttribute('role', 'region');
    this.ticker.setAttribute('aria-label', '시세 지표');
    this.ticker.addEventListener('focusin', (event) => {
      if (event.target instanceof HTMLElement && event.target.dataset.ticker) {
        event.target.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
      }
    });
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
    const focused = document.activeElement;
    const focusId = focused instanceof HTMLElement && this.ticker.contains(focused) ? focused.dataset.ticker : undefined;
    const scrollLeft = this.ticker.scrollLeft;
    let nextFocus: HTMLElement | null = null;
    this.ticker.replaceChildren();
    if (!items.length) {
      this.ticker.append(el('span', 'wfs-empty', '표시할 시세 지표가 없습니다'));
      return;
    }
    for (const item of items) {
      const control = item.url ? el('a', 'wfs-ticker-item') : el('button', 'wfs-ticker-item');
      const display = item.displayValue ?? (item.value === null ? '—' : `${item.value.toFixed(item.digits)}${item.unit ?? ''}`);
      control.dataset.ticker = item.id;
      if (focusId === item.id) nextFocus = control;
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
    this.ticker.scrollLeft = scrollLeft;
    nextFocus?.focus();
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
  private headline = el('span', 'wfs-dispatch-headline');
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
    this.render();
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
    this.headline.textContent = alert?.headline ?? '아직 수신한 속보가 없습니다.';
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

function setSwatch(node: HTMLElement, light: readonly number[], dark: readonly number[]): void {
  node.style.setProperty('--wfs-swatch-light', `rgb(${light.slice(0, 3).join(' ')})`);
  node.style.setProperty('--wfs-swatch-dark', `rgb(${dark.slice(0, 3).join(' ')})`);
}

export class WorldKeyPlate {
  readonly element: HTMLElement;
  private title = el('small', 'wfs-cii-title', 'CII');
  private scale = el('div', 'wfs-cii-scale');
  private lines = el('div', 'wfs-line-legend');

  constructor() {
    installStyle();
    this.element = el('aside', 'atlas-key-plate');
    const title = el('strong', 'wfs-key-title');
    title.append(el('span', '', '지도 범례'), this.title);
    const levels: Record<FillLevel, string> = { 0: '평온', 1: '관심', 2: '주의', 3: '경계', 4: '고위험' };
    for (const [key, label] of Object.entries(levels)) {
      const level = Number(key) as FillLevel;
      const chip = el('span', 'wfs-cii-step', label);
      chip.dataset.level = key;
      setSwatch(chip, WORLD_FILL_COLORS.light[level], WORLD_FILL_COLORS.dark[level]);
      this.scale.append(chip);
    }
    const markers = el('div', 'wfs-marker-legend');
    for (const [kind, label] of [
      ['hotspot-elevated', '관심 지역'], ['hotspot-high', '고위험 관심 지역'], ['waterway', '전략 해상 요충지'],
      ['conflict', '분쟁 지역'], ['hotspot-ring', '주요 분쟁국'], ['unrest', '사회 불안'], ['bloc', '외교 블록 경계'],
    ]) {
      const item = el('span', 'wfs-marker-key', label);
      item.dataset.marker = kind;
      if (kind === 'hotspot-ring') setSwatch(item, WORLD_HOTSPOT_COLORS.light, WORLD_HOTSPOT_COLORS.dark);
      if (kind === 'unrest') setSwatch(item, WORLD_UNREST_OUTLINE.light, WORLD_UNREST_OUTLINE.dark);
      if (kind === 'bloc') {
        for (const [theme, colors] of Object.entries(WORLD_BLOC_COLORS)) {
          item.style.setProperty(`--wfs-blocs-${theme}`, colors.map((color) => `rgb(${color.slice(0, 3).join(' ')})`).join(', '));
        }
      }
      markers.append(item);
    }
    this.element.append(title, this.scale, this.lines, markers);
    this.setView(false, []);
  }

  setView(showCii: boolean, relationKinds: readonly RelationKind[]): void {
    this.title.hidden = this.scale.hidden = !showCii;
    this.lines.replaceChildren();
    const kinds = new Set(relationKinds);
    for (const kind of Object.keys(KIND_LABEL_KO) as RelationKind[]) {
      if (!kinds.has(kind)) continue;
      const label = KIND_LABEL_KO[kind];
      const item = el('span', 'wfs-line-key', label);
      item.dataset.kind = label;
      this.lines.append(item);
    }
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
  constructor(private callbacks: { onFieldsChange?(fields: WorldField[]): void; onDateChange(date: string): void }, battle?: { filters: HTMLElement; windows: HTMLElement }) {
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
    if (battle) this.element.append(battle.filters, battle.windows, this.timeline);
    else {
      this.element.append(this.fieldBar, this.timeline);
      this.renderFields();
    }
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
        this.callbacks.onFieldsChange?.([...this.fields]);
      });
      this.fieldBar.append(b);
    }
  }
  setDates(available: string[], current: string): void {
    this.dates = [...new Set(available)].sort();
    if (current !== this.current || !this.dates.includes(current)) this.stop();
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
