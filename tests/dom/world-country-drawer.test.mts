import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorldCountryDrawer } from '../../src/components/world/WorldCountryDrawer';
import type { CountryDrawerData } from '../../src/types/world-overview';

function drawerData(overrides: Partial<CountryDrawerData> = {}): CountryDrawerData {
  return {
    iso2: 'KR', nameKo: '대한민국', nameEn: 'South Korea', level: 1, conflictLevel: 'tension', ciiScore: 42,
    updatedAt: Date.UTC(2026, 10, 22, 3, 0),
    issue: { summaryKo: '긴장이 이어지고 있습니다.', sources: [{ url: 'https://example.com/issue', title: '보도', publisher: '언론사' }] },
    relations: [{ id: 'rel-1', counterpartIso2: 'JP', counterpartName: '일본', kind: 'tension', field: 'geopolitics', origin: 'ai', direction: 'out', label: '외교 긴장', trend: 'rising', sources: [{ url: 'https://example.com/relation', title: '관계 보도', publisher: '통신사' }] }],
    blocs: [], isToday: true, aiStatus: 'ok', outages: [], ...overrides,
  };
}

afterEach(() => { document.body.replaceChildren(); });

describe('WorldCountryDrawer', () => {
  it('opens, updates, closes from its button and Escape, and destroys its listener', () => {
    const drawer = new WorldCountryDrawer({ onClose: vi.fn(), onSelectCountry: vi.fn(), onMark: vi.fn().mockResolvedValue(undefined), onOpenFullPanels: vi.fn() });
    document.body.append(drawer.element);
    expect(drawer.isOpen()).toBe(false);
    drawer.open(drawerData());
    expect(drawer.element.dataset.state).toBe('open');
    drawer.update(drawerData({ nameKo: '새 이름' }));
    expect(drawer.element.textContent).toContain('새 이름');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(drawer.isOpen()).toBe(false);
    expect(drawer.element.dataset.state).toBe('closed');
    drawer.open(drawerData());
    drawer.element.querySelector<HTMLButtonElement>('[data-action="close"]')!.click();
    expect(drawer.isOpen()).toBe(false);
    drawer.destroy();
  });

  it('renders sections in order and filters relation cards', () => {
    const data = drawerData({ relations: [
      drawerData().relations[0],
      { ...drawerData().relations[0], id: 'rel-2', counterpartIso2: 'CN', counterpartName: '중국', trend: 'easing' },
      { ...drawerData().relations[0], id: 'rel-3', counterpartIso2: 'US', counterpartName: '미국', trend: 'steady' },
    ] });
    const drawer = new WorldCountryDrawer({ onClose: vi.fn(), onSelectCountry: vi.fn(), onMark: vi.fn().mockResolvedValue(undefined), onOpenFullPanels: vi.fn() });
    drawer.open(data);
    const headings = [...drawer.element.querySelectorAll<HTMLElement>('[data-section]')].map((el) => el.dataset.section);
    expect(headings).toEqual(['header', 'ai-notice', 'issues', 'relations', 'infrastructure', 'sources', 'footer']);
    drawer.element.querySelector<HTMLButtonElement>('[data-filter="worsening"]')!.click();
    expect(drawer.element.querySelectorAll('[data-relation-card]')).toHaveLength(1);
    expect(drawer.element.textContent).toContain('일본');
    expect(drawer.element.textContent).not.toContain('중국');
  });

  it('selects counterpart countries and marks only today items; supports unmark and reappeared states', async () => {
    const onSelectCountry = vi.fn();
    const onMark = vi.fn().mockResolvedValue(undefined);
    const drawer = new WorldCountryDrawer({ onClose: vi.fn(), onSelectCountry, onMark, onOpenFullPanels: vi.fn() });
    drawer.open(drawerData());
    drawer.element.querySelector<HTMLButtonElement>('[data-counterpart="JP"]')!.click();
    expect(onSelectCountry).toHaveBeenCalledWith('JP');
    drawer.element.querySelector<HTMLButtonElement>('[data-mark-item="rel-1"]')!.click();
    expect(onMark).toHaveBeenCalledWith({ itemKind: 'relation', itemKey: 'rel-1', action: 'mark' });
    drawer.open(drawerData({ isToday: false }));
    expect(drawer.element.querySelector('[data-mark-item]')).toBeNull();
    drawer.open(drawerData({ relations: [{ ...drawerData().relations[0], mark: { state: 'hidden', markId: 'm1', markedAt: 1 } }] }));
    expect(drawer.element.textContent).toContain('틀림으로 표시함 · 취소');
    drawer.element.querySelector<HTMLButtonElement>('[data-unmark="m1"]')!.click();
    expect(onMark).toHaveBeenLastCalledWith({ action: 'unmark', markId: 'm1' });
    drawer.open(drawerData({ relations: [{ ...drawerData().relations[0], mark: { state: 'reappeared', markId: 'm2', markedAt: 1 } }] }));
    expect(drawer.element.textContent).toContain('다시 나타남, 이전에 틀림으로 표시함');
  });

  it('shows empty-state copy and opens source links safely in a new tab', () => {
    const drawer = new WorldCountryDrawer({ onClose: vi.fn(), onSelectCountry: vi.fn(), onMark: vi.fn().mockResolvedValue(undefined), onOpenFullPanels: vi.fn() });
    drawer.open(drawerData({ issue: null, relations: [], blocs: [] }));
    expect(drawer.element.textContent).toContain('오늘 등록된 핵심 이슈가 없습니다');
    expect(drawer.element.textContent).toContain('표시할 국가 간 관계가 없습니다');
    expect(drawer.element.textContent).toContain('최근 인터넷 차단 기록이 없습니다');
    drawer.open(drawerData());
    for (const link of drawer.element.querySelectorAll<HTMLAnchorElement>('a[data-source-link]')) {
      expect(link.target).toBe('_blank');
      expect(link.rel).toContain('noopener');
      expect(link.rel).toContain('noreferrer');
    }
  });

  it('lists internet outages with a safe IODA link', () => {
    const drawer = new WorldCountryDrawer({ onClose: vi.fn(), onSelectCountry: vi.fn(), onMark: vi.fn().mockResolvedValue(undefined), onOpenFullPanels: vi.fn() });
    drawer.open(drawerData({ outages: [{ id: 'ioda-1', start: Date.UTC(2026, 10, 22), end: null, severity: 'high', signals: ['BGP'], url: 'https://ioda.example/event' }] }));
    expect(drawer.element.querySelector('[data-section="infrastructure"]')?.textContent).toContain('BGP');
    expect(drawer.element.querySelector('[data-section="infrastructure"]')?.textContent).toContain('높음');
    const link = drawer.element.querySelector<HTMLAnchorElement>('[data-ioda-link]')!;
    expect(link.href).toBe('https://ioda.example/event');
    expect(link.rel).toContain('noopener');
  });
});
