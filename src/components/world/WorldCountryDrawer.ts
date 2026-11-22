import '../../styles/world-country-drawer.css';
import { AI_DISCLAIMER_KO, KIND_LABEL_KO, TREND_LABEL_KO } from '../../../shared/world-overview.js';
import type { CountryDrawerData, DrawerRelation, SourceLink, WorldMarkRequest } from '../../types/world-overview';

type RelationFilter = 'all' | 'worsening' | 'easing';
type MarkRequest = Extract<WorldMarkRequest, { action: 'mark' }>;

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
    content.append(this.renderHeader(data), this.renderNotice(data), this.renderIssues(data), this.renderRelations(data), this.renderSources(data), this.renderFooter(data));
    this.element.replaceChildren(content);
  }

  private renderHeader(data: CountryDrawerData): HTMLElement {
    const section = make('header', 'wfs-country-drawer__header');
    section.dataset.section = 'header';
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
