import { IMPACT_KINDS, IMPACT_STYLES, PRESSURE_FILL, isImpactKind, type ImpactKind } from '@/config/battle-map';
import { WORLD_FILL_COLORS } from '@/config/world-overview-palette';
import { impactCountry, impactDate, impactHeadline, impactTrend, type ImpactWindow } from '@/services/battle-map-view';
import type { GetImpactLinksResponse, ImpactLink } from '@/services/impact-links';
import type { BreakingAlert } from '@/services/breaking-news-alerts';
import type { FillLevel } from '@/types/world-overview';
import { impactMark, svg } from './BattleMapOverlay';

export function battleNode<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function battleButton(text: string, action: () => void, className = 'bm-button'): HTMLButtonElement {
  const node = battleNode('button', className, text);
  node.type = 'button';
  node.addEventListener('click', action);
  return node;
}

export function impactRow(link: ImpactLink, action: () => void): HTMLButtonElement {
  const text = `${impactHeadline(link)} · ${link.magnitude}`;
  const node = battleButton(text, action, 'bm-button bm-impact-row');
  node.dataset.kind = link.kind;
  node.dataset.impactId = link.id;
  return node;
}

const SOURCE_LABELS: Record<string, string> = {
  federalRegister: '미 연방관보', sanctionsChanges: '제재 변경 기록', ucdp: 'UCDP',
  relations: '외교 관계', energyNews: '에너지 뉴스', disruptions: '에너지 공급 차질',
  shortages: '연료 부족', auctions: '미 국채 입찰', funding: '단기 자금시장',
};

export class BattleMapChrome {
  readonly strip = battleNode('section', 'dispatch-bar bm-strip');
  readonly filters = battleNode('div', 'bm-filters');
  readonly windows = battleNode('div', 'bm-windows');
  readonly legend = battleNode('aside', 'atlas-key-plate bm-key-plate');
  readonly status = battleNode('section', 'bm-status');
  readonly counters = battleNode('div', 'bm-counts');
  readonly sources = battleNode('details', 'bm-sources');
  readonly logToggle: HTMLButtonElement;
  private readonly chips = battleNode('div', 'bm-strip-chips');
  private readonly title = battleNode('strong', 'bm-strip-title', '오늘의 전황');
  private readonly filterButtons = new Map<ImpactKind, HTMLButtonElement>();
  private readonly all: HTMLButtonElement;
  private readonly list: HTMLButtonElement;
  private readonly timeButtons = new Map<ImpactWindow, HTMLButtonElement>();
  private readonly scale = battleNode('div', 'wfs-cii-scale');
  private readonly keys = battleNode('div', 'bm-line-legend');
  private readonly conflictDate = battleNode('p', 'bm-key-note');
  private readonly legendContent = battleNode('div', 'bm-key-content');
  private readonly pressure: HTMLButtonElement;
  private readonly cii: HTMLButtonElement;
  private readonly legendToggle: HTMLButtonElement;
  private readonly pressureCount: HTMLButtonElement;
  private readonly surgeCount: HTMLButtonElement;
  private readonly frontCount: HTMLButtonElement;

  constructor(private readonly actions: {
    selectLink(link: ImpactLink, trigger: HTMLElement | SVGElement): void;
    locate(alert: BreakingAlert): void;
    toggleLog(): void;
    chooseKind(kind: ImpactKind): void;
    allKinds(): void;
    showList(trigger: HTMLElement): void;
    setWindow(window: ImpactWindow): void;
    setCii(enabled: boolean): void;
    focusFront(): void;
    retry(): void;
  }) {
    this.strip.setAttribute('aria-label', '오늘의 전황');
    this.chips.tabIndex = 0;
    this.chips.setAttribute('aria-label', '전황 항목');
    const scroll = (direction: number) => this.chips.scrollBy({ left: 254 * direction, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
    const prev = battleButton('‹', () => scroll(-1), 'bm-button bm-strip-step');
    const next = battleButton('›', () => scroll(1), 'bm-button bm-strip-step');
    prev.setAttribute('aria-label', '이전 전황');
    next.setAttribute('aria-label', '다음 전황');
    this.logToggle = battleButton('로그', actions.toggleLog, 'bm-button wfs-log-toggle');
    this.logToggle.id = 'logToggleBtn';
    this.strip.append(this.title, this.chips, prev, next, this.logToggle);
    this.filters.setAttribute('aria-label', '영향선 유형');
    this.all = battleButton('전체', actions.allKinds);
    this.filters.append(this.all);
    for (const kind of IMPACT_KINDS) {
      const button = battleButton(IMPACT_STYLES[kind].label, () => actions.chooseKind(kind));
      button.dataset.kind = kind;
      button.title = IMPACT_STYLES[kind].detail;
      this.filterButtons.set(kind, button);
      this.filters.append(button);
    }
    this.list = battleButton('영향선 목록', () => actions.showList(this.list));
    this.list.classList.add('bm-list-toggle');
    this.filters.append(this.list);
    for (const window of ['24h', '7d'] as const) {
      const button = battleButton(window.toUpperCase(), () => actions.setWindow(window));
      this.timeButtons.set(window, button);
      this.windows.append(button);
    }
    this.legendToggle = battleButton('범례 ▾', () => {
      const open = this.legend.dataset.open !== 'true';
      this.legend.dataset.open = String(open);
      this.legendToggle.setAttribute('aria-expanded', String(open));
    }, 'bm-button bm-legend-toggle');
    this.legendToggle.setAttribute('aria-expanded', 'false');
    this.pressure = battleButton('압박도', () => actions.setCii(false));
    this.cii = battleButton('CII', () => actions.setCii(true));
    const keyTitle = battleNode('div', 'bm-key-title');
    keyTitle.append(battleNode('strong', '', '전황 범례'), this.pressure, this.cii);
    this.legendContent.append(keyTitle, this.scale, battleNode('p', 'bm-key-note', '◇ 발신 거점 · 굵기 = 강도 · 투명도 = 경과 시간'), this.keys, this.conflictDate);
    this.legend.append(this.legendToggle, this.legendContent);
    this.status.setAttribute('role', 'status');
    this.status.hidden = true;
    this.pressureCount = battleButton('압박 0', actions.allKinds);
    this.surgeCount = battleButton('급등 0', () => actions.setWindow('24h'));
    this.frontCount = battleButton('전선 0', actions.focusFront, 'bm-button bm-front-count');
    this.counters.append(this.pressureCount, this.surgeCount, this.frontCount);
    this.sources.hidden = true;
  }

  setLog(open: boolean, count: number): void {
    this.logToggle.textContent = `로그 ${count}`;
    this.logToggle.setAttribute('aria-expanded', String(open));
  }

  setToday(today: ImpactLink[], alert: BreakingAlert | undefined, selected: string | undefined, asOf: number, message: string): void {
    this.title.textContent = `오늘의 전황 ${today.length + Number(Boolean(alert))}`;
    const row: HTMLElement[] = [];
    if (alert) {
      const chip = battleButton(`● 속보 · ${alert.headline}`, () => this.actions.locate(alert), 'bm-button bm-chip bm-breaking');
      chip.title = alert.headline;
      row.push(chip);
    }
    for (const link of today) {
      const title = impactHeadline(link);
      const trend = impactTrend(link, asOf);
      const chip = battleButton('', () => this.actions.selectLink(link, chip), 'bm-button bm-chip');
      chip.dataset.kind = link.kind;
      chip.dataset.impactId = link.id;
      chip.setAttribute('aria-pressed', String(link.id === selected));
      chip.title = title;
      chip.append(battleNode('span', 'bm-chip-label', title));
      if (trend) {
        const badge = battleNode('small', 'bm-trend', trend);
        badge.dataset.trend = link.trend;
        chip.append(badge);
      }
      row.push(chip);
    }
    if (!row.length) row.push(battleNode('span', 'bm-empty-strip', message));
    const scroll = this.chips.scrollLeft;
    this.chips.replaceChildren(...row);
    this.chips.scrollLeft = scroll;
  }

  setFilters(active: ReadonlySet<ImpactKind>, links: ImpactLink[], window: ImpactWindow, displayed: number, fronts: number, asOf: number): void {
    const counts: Record<string, number> = {};
    for (const { kind } of links) counts[kind] = (counts[kind] ?? 0) + 1;
    const visible = links.filter((link) => isImpactKind(link.kind) && active.has(link.kind));
    this.all.textContent = `전체 ${links.length}`;
    this.all.setAttribute('aria-pressed', String(active.size === IMPACT_KINDS.length));
    for (const [kind, button] of this.filterButtons) {
      button.textContent = `${IMPACT_STYLES[kind].label} ${counts[kind] ?? 0}`;
      button.setAttribute('aria-pressed', String(active.has(kind)));
    }
    for (const [key, button] of this.timeButtons) button.setAttribute('aria-pressed', String(window === key));
    this.pressureCount.textContent = `압박 ${visible.filter((link) => link.direction === 'pressure').length}`;
    this.surgeCount.textContent = `급등 ${visible.filter((link) => impactTrend(link, asOf) === '급등').length}`;
    this.frontCount.textContent = `전선 ${fronts}`;
    this.frontCount.disabled = !fronts;
    const hidden = Math.max(0, visible.length - displayed);
    this.list.textContent = hidden ? `목록 +${hidden}` : '영향선 목록';
    this.list.disabled = !visible.length;
  }

  setLegend(cii: boolean, kinds: ImpactKind[], ucdpAsOf: number): void {
    this.pressure.setAttribute('aria-pressed', String(!cii));
    this.cii.setAttribute('aria-pressed', String(cii));
    const levels = cii ? ['평온', '관심', '주의', '경계', '고위험'] : ['평온', '저압', '경계', '집중', '포화'];
    const palette = cii ? WORLD_FILL_COLORS : PRESSURE_FILL;
    this.conflictDate.hidden = !ucdpAsOf || !kinds.includes('conflict');
    this.conflictDate.textContent = this.conflictDate.hidden ? '' : `UCDP 자료 기준 ${impactDate(ucdpAsOf)}`;
    this.scale.replaceChildren(...levels.map((label, index) => {
      const chip = battleNode('span', 'wfs-cii-step', label);
      chip.dataset.level = String(index);
      for (const theme of ['light', 'dark'] as const) chip.style.setProperty(`--wfs-swatch-${theme}`, `rgb(${palette[theme][index as FillLevel]!.slice(0, 3).join(' ')})`);
      return chip;
    }));
    this.keys.replaceChildren(...IMPACT_KINDS.filter((kind) => kinds.includes(kind)).map((kind) => {
      const key = battleNode('span', 'bm-line-key', IMPACT_STYLES[kind].label);
      key.dataset.kind = kind;
      const icon = svg('svg', { width: 30, height: 12, 'aria-hidden': 'true' });
      icon.append(svg('path', { d: 'M1 6H23', stroke: 'currentColor', 'stroke-width': 2, 'stroke-dasharray': IMPACT_STYLES[kind].dash || 'none' }));
      const mark = impactMark(kind);
      mark.setAttribute('transform', 'translate(19 0)');
      icon.append(mark);
      key.prepend(icon);
      return key;
    }));
  }

  setSources(sources: GetImpactLinksResponse['sources'], asOf: number): void {
    const delayed = sources.filter((source) => source.status !== 'available').length;
    this.sources.hidden = !delayed;
    this.sources.replaceChildren();
    if (!delayed) return;
    const list = battleNode('ul', 'bm-source-list');
    for (const source of sources) {
      const state = source.status === 'missing' ? '수집 자료 없음' : source.status === 'delayed' ? '자료 지연' : '수집됨';
      list.append(battleNode('li', '', `${SOURCE_LABELS[source.id] ?? source.id} · ${state}${source.dataAsOf ? ` · 자료 기준 ${impactDate(source.dataAsOf)}` : ''}`));
    }
    if (asOf) list.append(battleNode('li', '', `전황 집계 ${impactDate(asOf)}`));
    this.sources.append(battleNode('summary', '', `출처 지연 ${delayed}/${sources.length}`), list);
  }

  setStatus(state: 'ok' | 'loading' | 'filtered' | 'empty' | 'error' | 'archive', window: ImpactWindow): void {
    this.status.dataset.state = state;
    this.status.hidden = state === 'ok';
    const labels = {
      ok: '', loading: '전황 데이터를 불러오는 중', filtered: '선택한 유형과 시간창에 해당하는 영향선이 없습니다.',
      empty: '수집된 전황 데이터가 없습니다.', error: '전황 데이터를 불러오지 못했습니다.', archive: '이 날짜의 전황 기록이 없습니다. 보관된 CII를 표시합니다.',
    };
    this.status.replaceChildren(battleNode('span', '', labels[state]));
    if (state === 'filtered') {
      if (window === '24h') this.status.append(battleButton('7D로 확장', () => this.actions.setWindow('7d')));
      this.status.append(battleButton('전체 유형 보기', this.actions.allKinds));
    }
    if (state === 'error' || state === 'empty') this.status.append(battleButton('다시 불러오기', this.actions.retry));
  }
}

export class BattleEvidenceDrawer {
  readonly element = battleNode('aside', 'wfs-country-drawer bm-link-drawer');
  constructor(private readonly close: () => void, private readonly country: (code: string) => void) {
    this.element.setAttribute('aria-label', '영향선 근거');
    this.hide();
  }

  private show(title: string, label: string): HTMLElement {
    this.element.dataset.state = 'open';
    this.element.setAttribute('aria-hidden', 'false');
    this.element.inert = false;
    const content = battleNode('div', 'wfs-country-drawer__content bm-evidence-content');
    const header = battleNode('header', 'wfs-country-drawer__header');
    const row = battleNode('div', 'wfs-country-drawer__title-row');
    row.append(battleNode('h2', '', title), battleButton('닫기', this.close));
    header.append(battleNode('p', 'wfs-country-drawer__kicker', label), row);
    content.append(header);
    this.element.replaceChildren(content);
    return content;
  }

  showList(links: ImpactLink[], select: (link: ImpactLink) => void): void {
    const content = this.show(`영향선 ${links.length}건`, '전황 지도');
    const list = battleNode('div', 'bm-evidence-list');
    list.append(...links.map((link) => impactRow(link, () => select(link))));
    content.append(list);
  }

  showLink(link: ImpactLink, bundle: ImpactLink[], select: (link: ImpactLink) => void): void {
    const label = isImpactKind(link.kind) ? IMPACT_STYLES[link.kind].detail : '영향선';
    const content = this.show(label, '영향선 근거');
    const endpoints = battleNode('div', 'bm-endpoints');
    const endpoint = (code: string) => ['EU', 'UN', 'NATO'].includes(code)
      ? battleNode('span', '', impactCountry(code)) : battleButton(impactCountry(code), () => this.country(code));
    endpoints.append(endpoint(link.actor));
    if (link.target !== link.actor) endpoints.append(battleNode('span', '', '→'), endpoint(link.target));
    content.append(endpoints, battleNode('p', 'bm-evidence-metrics', `강도 ${link.magnitude}/100 · 자료 기준 ${impactDate(link.lastSeen)}`));
    if (link.kind === 'conflict') content.append(battleNode('p', 'bm-evidence-note', 'UCDP 사건 기록입니다. 국가 간 선은 두 당사자와 사건 발생국의 관계를 나타냅니다.'));
    if (link.headline && /[가-힣]/.test(link.headline)) content.append(battleNode('p', 'bm-evidence-note', link.headline));
    if (bundle.length > 1) {
      const siblings = battleNode('div', 'bm-evidence-tabs');
      for (const candidate of bundle) {
        if (!isImpactKind(candidate.kind)) continue;
        const tab = battleButton(IMPACT_STYLES[candidate.kind].label, () => select(candidate));
        tab.setAttribute('aria-pressed', String(candidate.id === link.id));
        siblings.append(tab);
      }
      content.append(siblings);
    }
    const list = battleNode('ul', 'bm-evidence-list');
    for (const evidence of link.evidence) {
      const item = battleNode('li', '');
      item.append(battleNode('small', 'bm-source-label', `${evidence.source} · ${impactDate(evidence.publishedAt)}`));
      const url = this.safeUrl(evidence.url);
      if (url) {
        const anchor = battleNode('a', '', evidence.title);
        anchor.href = url;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        item.append(anchor);
      } else item.append(battleNode('span', '', evidence.title));
      list.append(item);
    }
    content.append(battleNode('h3', '', `출처별 근거 ${link.evidence.length}건`), list);
  }

  hide(): void {
    this.element.dataset.state = 'closed';
    this.element.setAttribute('aria-hidden', 'true');
    this.element.inert = true;
  }

  private safeUrl(value: string): string | null {
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  }
}
