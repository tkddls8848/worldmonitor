import '../../styles/world-country-drawer.css';
import { AI_DISCLAIMER_KO, KIND_LABEL_KO, TREND_LABEL_KO } from '../../../shared/world-overview.js';
import { federalRegisterLabel } from '@/services/federal-register';
import type { CountryDrawerData, DrawerRelation, FederalRegisterDocument, SourceLink, WorldMarkRequest } from '../../types/world-overview';

type RelationFilter = 'all' | 'worsening' | 'easing';
type MarkRequest = Extract<WorldMarkRequest, { action: 'mark' }>;
const OUTAGE_SEVERITY_KO = { low: '낮음', medium: '중간', high: '높음' } as const;

export interface WorldCountryDrawerOptions {
  onClose: () => void;
  onSelectCountry: (iso2: string) => void;
  onMark: (req: WorldMarkRequest) => Promise<void>;
  onOpenFullPanels: (iso2: string) => void;
}

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
};

function isWorsening(relation: DrawerRelation): boolean {
  return relation.trend === 'rising' || relation.trend === 'surging';
}

function isEasing(relation: DrawerRelation): boolean {
  return relation.trend === 'easing';
}

function formatUpdatedAt(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '갱신 시각 없음';
  return `갱신 ${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(value)}`;
}

function validSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

/** Korea card: render an ECOS indicator in the units a reader expects. */
function formatKrIndicator(indicator: { id: string; value: number; unit: string }): string {
  const n = (value: number, digits: number): string => value.toLocaleString('ko-KR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  switch (indicator.id) {
    case 'fx-reserves': return `${n(indicator.value / 100_000, 0)}억 달러`; // ECOS reports thousand USD
    case 'current-account': return `${n(indicator.value / 100, 1)}억 달러`; // ECOS reports million USD
    case 'kospi': return n(indicator.value, 2); // unit text is the index base date
    case 'usdkrw': return `${n(indicator.value, 1)}원`;
    case 'base-rate': case 'ktb3y': case 'ktb10y': case 'cpi-yoy': case 'unemployment': return `${n(indicator.value, 2)}%`;
    default: return `${n(indicator.value, 2)}${indicator.unit}`;
  }
}

/** YoY percent with one decimal and a sign, or a dash. */
function formatYoy(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return 'YoY —';
  return `YoY ${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
}

/** HS names can be whole tariff clauses; keep the card readable. */
function shortItemName(name: string): string {
  return name.length > 14 ? `${name.slice(0, 14)}…` : name;
}

export class WorldCountryDrawer {
  readonly element: HTMLElement;
  private readonly options: WorldCountryDrawerOptions;
  private data: CountryDrawerData | null = null;
  private filter: RelationFilter = 'all';
  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && this.isOpen()) {
      event.stopPropagation();
      this.close();
    }
  };

  constructor(options: WorldCountryDrawerOptions) {
    this.options = options;
    this.element = make('aside', 'wfs-country-drawer');
    this.element.dataset.state = 'closed';
    this.element.setAttribute('aria-label', '국가 상세');
    this.element.setAttribute('aria-hidden', 'true');
    document.addEventListener('keydown', this.onKeyDown);
  }

  open(data: CountryDrawerData): void {
    this.data = data;
    this.filter = 'all';
    this.render();
    this.element.dataset.state = 'open';
    this.element.setAttribute('aria-hidden', 'false');
  }

  update(data: CountryDrawerData): void {
    const wasOpen = this.isOpen();
    this.data = data;
    this.render();
    this.element.dataset.state = wasOpen ? 'open' : 'closed';
    this.element.setAttribute('aria-hidden', wasOpen ? 'false' : 'true');
  }

  close(): void {
    if (!this.isOpen()) return;
    this.element.dataset.state = 'closed';
    this.element.setAttribute('aria-hidden', 'true');
    this.options.onClose();
  }

  isOpen(): boolean {
    return this.element.dataset.state === 'open';
  }

  destroy(): void {
    document.removeEventListener('keydown', this.onKeyDown);
    this.element.remove();
    this.data = null;
  }

  private render(): void {
    const data = this.data;
    if (!data) return;
    const content = make('div', 'wfs-country-drawer__content');
    content.append(this.renderHeader(data), this.renderNotice(data), this.renderIssues(data), this.renderRelations(data), this.renderOutages(data));
    if (data.federalRegister?.length) content.append(this.renderFederalRegister(data.federalRegister));
    if (data.iso2 === 'KR') content.append(this.renderKorea(data));
    content.append(this.renderSources(data), this.renderFooter(data));
    this.element.replaceChildren(content);
  }

  private renderHeader(data: CountryDrawerData): HTMLElement {
    const section = make('header', 'wfs-country-drawer__header');
    section.dataset.section = 'header';
    section.append(make('p', 'wfs-country-drawer__kicker', `OPS BRIEF // ${data.iso2} // CII-${data.ciiScore === null ? '—' : Math.round(data.ciiScore)}`));
    const titleRow = make('div', 'wfs-country-drawer__title-row');
    const identity = make('div', 'wfs-country-drawer__identity');
    const code = make('span', 'wfs-country-drawer__iso num', data.iso2);
    const names = make('div', 'wfs-country-drawer__names');
    names.append(make('h2', 'wfs-country-drawer__name-ko', data.nameKo), make('p', 'wfs-country-drawer__name-en', data.nameEn));
    identity.append(code, names);
    const close = make('button', 'wfs-country-drawer__close', '닫기');
    close.type = 'button';
    close.dataset.action = 'close';
    close.setAttribute('aria-label', '국가 상세 닫기');
    close.addEventListener('click', () => this.close());
    titleRow.append(identity, close);
    section.append(titleRow);

    const gauge = make('div', 'wfs-country-drawer__gauge');
    const score = Math.max(0, Math.min(100, Math.round(data.ciiScore ?? 0)));
    const gaugeLabel = make('div', 'wfs-country-drawer__gauge-label');
    gaugeLabel.append(make('span', '', '불안정 지수'), make('span', 'num', data.ciiScore === null ? '자료 없음' : `${score} / 100`));
    const track = make('div', 'wfs-country-drawer__gauge-track');
    const fill = make('span', 'wfs-country-drawer__gauge-fill');
    fill.style.width = `${data.ciiScore === null ? 0 : score}%`;
    track.append(fill);
    gauge.append(gaugeLabel, track, make('time', 'wfs-country-drawer__updated', formatUpdatedAt(data.updatedAt)));
    section.append(gauge);
    return section;
  }

  private renderNotice(data: CountryDrawerData): HTMLElement {
    const notice = make('section', 'wfs-country-drawer__notice');
    notice.dataset.section = 'ai-notice';
    const copy = make('p', '', `${AI_DISCLAIMER_KO}.`);
    if (data.aiStatus === 'stale') copy.append(document.createTextNode(' 요약 데이터가 오래되었습니다.'));
    if (data.aiStatus === 'missing') copy.append(document.createTextNode(' AI 요약 자료가 없습니다.'));
    notice.append(copy);
    const feedback = make('button', 'wfs-country-drawer__mark', '틀림 신고');
    feedback.type = 'button';
    feedback.disabled = !data.isToday || data.aiStatus === 'missing';
    feedback.title = data.isToday ? 'AI 요약이 틀렸다고 표시' : '오늘 자료에서만 신고할 수 있습니다';
    feedback.addEventListener('click', () => {
      if (data.isToday && data.issue && !data.issue.mark) void this.options.onMark({ itemKind: 'issue', itemKey: data.iso2, action: 'mark' });
    });
    if (data.issue) {
      const mark = this.renderMark(data.issue.mark, data.isToday, { itemKind: 'issue', itemKey: data.iso2, action: 'mark' });
      if (mark) notice.append(mark);
      else if (!data.issue.mark && data.isToday) notice.append(feedback);
    } else {
      notice.append(make('span', 'wfs-country-drawer__mark-unavailable', data.isToday ? '신고할 요약이 없습니다' : '오늘 자료만 신고할 수 있습니다'));
    }
    return notice;
  }

  private renderIssues(data: CountryDrawerData): HTMLElement {
    const section = this.section('issues', '오늘의 핵심 이슈');
    if (!data.issue) {
      section.append(make('p', 'wfs-country-drawer__empty', '오늘 등록된 핵심 이슈가 없습니다'));
      return section;
    }
    const summary = make('p', 'wfs-country-drawer__issue-summary', data.issue.summaryKo || '오늘 등록된 핵심 이슈가 없습니다');
    section.append(summary);
    return section;
  }

  private renderRelations(data: CountryDrawerData): HTMLElement {
    const section = this.section('relations', '국가 간 관계');
    const filters = make('div', 'wfs-country-drawer__filters');
    const choices: Array<[RelationFilter, string]> = [['all', '전체'], ['worsening', '▲ 악화'], ['easing', '▼ 완화']];
    for (const [key, label] of choices) {
      const button = make('button', 'wfs-country-drawer__filter', label);
      button.type = 'button';
      button.dataset.filter = key;
      button.setAttribute('aria-pressed', String(this.filter === key));
      if (this.filter === key) button.classList.add('is-active');
      button.addEventListener('click', () => { this.filter = key; this.render(); });
      filters.append(button);
    }
    section.append(filters);
    const visible = data.relations.filter((relation) => this.filter === 'all' || (this.filter === 'worsening' ? isWorsening(relation) : isEasing(relation)));
    if (visible.length === 0) {
      section.append(make('p', 'wfs-country-drawer__empty', data.relations.length ? '선택한 추세의 관계가 없습니다' : '표시할 국가 간 관계가 없습니다'));
      return section;
    }
    const list = make('div', 'wfs-country-drawer__relation-list');
    for (const relation of visible) list.append(this.renderRelation(data, relation));
    section.append(list);
    return section;
  }

  private renderRelation(data: CountryDrawerData, relation: DrawerRelation): HTMLElement {
    const card = make('article', 'wfs-country-drawer__relation-card');
    card.dataset.relationCard = '';
    card.dataset.relationId = relation.id;
    const counterpart = make('button', 'wfs-country-drawer__counterpart', relation.counterpartName || relation.counterpartIso2);
    counterpart.type = 'button';
    counterpart.dataset.counterpart = relation.counterpartIso2;
    counterpart.addEventListener('click', () => this.options.onSelectCountry(relation.counterpartIso2));
    const kind = KIND_LABEL_KO[relation.kind] ?? relation.kind;
    const trend = relation.trend ? TREND_LABEL_KO[relation.trend] : '추세 자료 없음';
    const direction = relation.direction === 'out' ? '→' : relation.direction === 'in' ? '←' : '↔';
    const detail = make('p', 'wfs-country-drawer__relation-detail', `${direction} ${kind} · ${trend}`);
    const label = make('p', 'wfs-country-drawer__relation-label', relation.label);
    card.append(counterpart, detail, label);
    const mark = this.renderMark(relation.mark, data.isToday, { itemKind: 'relation', itemKey: relation.id, action: 'mark' });
    if (mark) card.append(mark);
    return card;
  }

  private renderMark(mark: { state: 'hidden' | 'reappeared'; markId: string; markedAt: number } | undefined, isToday: boolean, request: MarkRequest): HTMLElement | null {
    if (mark?.state === 'reappeared') return make('p', 'wfs-country-drawer__reappeared', '다시 나타남, 이전에 틀림으로 표시함');
    if (mark?.state === 'hidden') {
      const button = make('button', 'wfs-country-drawer__unmark', '틀림으로 표시함 · 취소');
      button.type = 'button';
      button.dataset.unmark = mark.markId;
      button.disabled = !isToday;
      button.addEventListener('click', () => { if (isToday) void this.options.onMark({ action: 'unmark', markId: mark.markId }); });
      return button;
    }
    if (!isToday) return null;
    const button = make('button', 'wfs-country-drawer__mark', '틀림 신고');
    button.type = 'button';
    button.dataset.markItem = request.itemKind === 'relation' ? request.itemKey : request.itemKey;
    button.addEventListener('click', () => void this.options.onMark(request));
    return button;
  }

  private renderSources(data: CountryDrawerData): HTMLElement {
    const section = this.section('sources', '출처 링크');
    const sources: SourceLink[] = [];
    if (data.issue) sources.push(...data.issue.sources);
    for (const relation of data.relations) sources.push(...relation.sources);
    const seen = new Set<string>();
    const list = make('ul', 'wfs-country-drawer__source-list');
    for (const source of sources) {
      const url = validSourceUrl(source.url);
      if (!url || seen.has(url)) continue;
      seen.add(url);
      const item = make('li');
      const link = make('a', 'wfs-country-drawer__source-link', source.title || source.publisher || url);
      link.href = url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.dataset.sourceLink = '';
      link.append(document.createTextNode(` · ${source.publisher}`));
      if (source.publishedAt) {
        const time = make('time', 'wfs-country-drawer__source-time', new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(source.publishedAt));
        item.append(link, time);
      } else item.append(link);
      list.append(item);
    }
    if (list.childElementCount) section.append(list);
    else section.append(make('p', 'wfs-country-drawer__empty', '등록된 출처가 없습니다'));
    return section;
  }

  private renderKorea(data: CountryDrawerData): HTMLElement {
    const section = this.section('korea-economy', '한국 경제');
    const korea = data.korea;
    if (!korea?.indicators.length) section.append(make('p', 'wfs-country-drawer__empty', 'ECOS 지표를 불러오지 못했습니다.'));
    else {
      const grid = make('div', 'wfs-country-drawer__kr-grid');
      const labelById: Record<string, string> = { 'base-rate': '기준금리', usdkrw: '원/달러', ktb3y: '국고채 3년', ktb10y: '국고채 10년', 'cpi-yoy': '소비자물가', unemployment: '실업률', 'fx-reserves': '외환보유액', kospi: 'KOSPI', 'current-account': '경상수지' };
      const indicators = new Map(korea.indicators.map((indicator) => [indicator.id, indicator]));
      for (const [id, label] of Object.entries(labelById)) {
        const indicator = indicators.get(id);
        const item = make('div', 'wfs-country-drawer__kr-metric');
        item.append(make('span', 'wfs-country-drawer__kr-label', label));
        const value = make('strong', 'wfs-country-drawer__kr-value', indicator ? formatKrIndicator(indicator) : '자료 없음');
        item.append(value, make('small', 'wfs-country-drawer__kr-period', indicator?.period ?? '기간 없음'));
        grid.append(item);
      }
      section.append(grid);
    }
    const trade = korea?.trade;
    if (!trade) section.append(make('p', 'wfs-country-drawer__empty', '관세청 무역 통계를 불러오지 못했습니다.'));
    else {
      const billion = (value: number): string => `${(value / 100_000_000).toLocaleString('ko-KR', { maximumFractionDigits: 1 })}억 달러`;
      const month = `${trade.month.slice(0, 4)}년 ${Number(trade.month.slice(4, 6))}월`;
      const totals = make('p', 'wfs-country-drawer__kr-trade', `${month}: 수출 ${billion(trade.total.exportUsd)} (${formatYoy(trade.total.exportYoyPct)}) · 수입 ${billion(trade.total.importUsd)} (${formatYoy(trade.total.importYoyPct)}) · 무역수지 ${billion(trade.total.balanceUsd)}`);
      section.append(totals);
      if (trade.provisional) section.append(make('p', 'wfs-country-drawer__kr-trade', `${trade.provisional.period} 잠정 수출 ${billion(trade.provisional.exportUsd)} · ${formatYoy(trade.provisional.exportYoyPct)}`));
      const partners = make('p', 'wfs-country-drawer__kr-trade', `주요 수출국: ${trade.partners.slice(0, 5).map((partner) => partner.nameKo).join(' · ') || '자료 없음'}`);
      section.append(partners);
      const items = [...trade.items].sort((a, b) => Number(b.nameKo.includes('반도체')) - Number(a.nameKo.includes('반도체'))).slice(0, 5);
      section.append(make('p', 'wfs-country-drawer__kr-trade', `주요 품목: ${items.map((item) => `${shortItemName(item.nameKo)}${item.exportYoyPct == null ? '' : ` ${formatYoy(item.exportYoyPct).replace('YoY ', '')}`}`).join(' · ') || '자료 없음'}`));
    }
    const filings = (korea?.disclosures ?? []).filter((filing) => filing.kind === 'major').sort((a, b) => b.at - a.at).slice(0, 5);
    if (!filings.length) section.append(make('p', 'wfs-country-drawer__empty', '최근 주요 공시가 없습니다.'));
    else {
      const list = make('ul', 'wfs-country-drawer__kr-filings');
      for (const filing of filings) {
        const item = make('li');
        const link = make('a', 'wfs-country-drawer__source-link', `${filing.corpName} · ${filing.title}`);
        const url = validSourceUrl(filing.url);
        if (url) { link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; }
        item.append(link);
        list.append(item);
      }
      section.append(list);
    }
    return section;
  }

  private renderFederalRegister(documents: FederalRegisterDocument[]): HTMLElement {
    const section = this.section('federal-register', '미 연방관보');
    const list = make('ul', 'wfs-country-drawer__source-list');
    for (const doc of documents) {
      const row = make('li');
      const date = make('time', 'wfs-country-drawer__source-time', doc.date);
      date.dateTime = doc.date;
      row.append(date, make('span', 'wfs-country-drawer__source-time', federalRegisterLabel(doc)));
      const url = validSourceUrl(doc.url);
      if (url) {
        const link = make('a', 'wfs-country-drawer__source-link', doc.title);
        link.href = url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        row.append(link);
      } else {
        row.append(make('span', 'wfs-country-drawer__source-time', doc.title));
      }
      list.append(row);
    }
    section.append(list);
    return section;
  }

  private renderOutages(data: CountryDrawerData): HTMLElement {
    const section = this.section('infrastructure', '인프라');
    if (!data.outages.length) {
      section.append(make('p', 'wfs-country-drawer__empty', '최근 인터넷 차단 기록이 없습니다'));
      return section;
    }
    const list = make('ul', 'wfs-country-drawer__outage-list');
    for (const outage of data.outages) {
      const item = make('li', 'wfs-country-drawer__outage');
      const time = make('time', 'wfs-country-drawer__source-time', new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(outage.start));
      const detail = make('span', `wfs-country-drawer__outage-severity is-${outage.severity}`, `${OUTAGE_SEVERITY_KO[outage.severity]} · ${outage.signals.join(', ')}`);
      const url = validSourceUrl(outage.url);
      item.append(time, detail);
      if (url) {
        const link = make('a', 'wfs-country-drawer__source-link', 'IODA');
        link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.dataset.iodaLink = '';
        item.append(link);
      }
      list.append(item);
    }
    section.append(list);
    return section;
  }

  private renderFooter(data: CountryDrawerData): HTMLElement {
    const footer = make('footer', 'wfs-country-drawer__footer');
    footer.dataset.section = 'footer';
    const button = make('button', 'wfs-country-drawer__full-panels', '이 국가의 전체 86개 패널 열기');
    button.type = 'button';
    button.addEventListener('click', () => this.options.onOpenFullPanels(data.iso2));
    footer.append(button);
    return footer;
  }

  private section(name: string, title: string): HTMLElement {
    const section = make('section', 'wfs-country-drawer__section');
    section.dataset.section = name;
    section.append(make('h3', 'wfs-country-drawer__section-title', title));
    return section;
  }
}
