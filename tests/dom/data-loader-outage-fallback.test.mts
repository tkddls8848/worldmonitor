/**
 * Panels read only digests (unified news catalog plan, KTD9). When no digest
 * carries a category the panel renders empty; the browser never fetches feeds
 * directly.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AppContext } from '@/app/app-context';
import type { ListFeedDigestResponse } from '@/generated/client/worldmonitor/news/v1/service_client';

const mocks = vi.hoisted(() => ({
  fetchCategoryFeeds: vi.fn(),
  isDesktopRuntime: vi.fn(() => false),
  toggles: {} as Record<string, boolean>,
}));

vi.mock('@/services/analysis-worker', () => ({
  analysisWorker: { clusterNews: vi.fn(), analyzeCorrelations: vi.fn() },
}));
vi.mock('@/services/rss', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/rss')>(),
  fetchCategoryFeeds: mocks.fetchCategoryFeeds,
  getFeedFailures: () => new Map(),
}));
vi.mock('@/services/runtime', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime')>(),
  isDesktopRuntime: mocks.isDesktopRuntime,
}));
vi.mock('@/services/runtime-config', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/services/runtime-config')>(),
  isFeatureEnabled: (id: string) => mocks.toggles[id] ?? true,
}));

interface NewsItemLike { source: string; title: string; link?: string }
type FeedLike = { name: string; url: string; lang?: string };
type Selection = { digest: ListFeedDigestResponse; servedStale: boolean } | null;

interface LoaderInternals {
  loadNewsCategory(
    category: string,
    feeds: FeedLike[],
    digest: Selection,
    isCustom: boolean,
    options: { recordBaselineSample: boolean; digestPending: boolean },
    generation?: number,
    recordSelectedFreshness?: (servedStale: boolean) => void,
  ): Promise<NewsItemLike[]>;
  loadIntelNews(digest: Selection, options: { recordBaselineSample: boolean; digestPending: boolean }): Promise<NewsItemLike[]>;
}

const OPTIONS = { recordBaselineSample: false, digestPending: false };
const PENDING = { recordBaselineSample: false, digestPending: true };
const feeds = (names: string[]): FeedLike[] => names.map(name => ({ name, url: `https://feeds.example/${encodeURIComponent(name)}` }));

async function makeLoader() {
  const statusPanel = { updateDigestCoverage: vi.fn(), updateFeed: vi.fn(), updateApi: vi.fn() };
  const panels = {
    politics: { renderNews: vi.fn(), renderFilteredEmpty: vi.fn(), setRefreshDegraded: vi.fn() },
  };
  const ctx = {
    statusPanel,
    disabledSources: new Set<string>(),
    newsCategoryPanelKeys: new Map<string, string>(),
    newsPanels: panels,
    panels,
    newsByCategory: {},
    currentTimeRange: 'all',
    allNews: [],
    latestClusters: [],
  } as unknown as AppContext;
  const { DataLoaderManager } = await import('@/app/data-loader');
  const loader = new DataLoaderManager(ctx, { renderCriticalBanner: () => undefined, refreshOpenCountryBrief: () => undefined });
  return { loader: loader as unknown as LoaderInternals, ctx, statusPanel, panels };
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // Any other request (edition digests, source rows) is an outage here.
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
  mocks.fetchCategoryFeeds.mockReset();
  mocks.fetchCategoryFeeds.mockImplementation(async (requested: FeedLike[]) => requested.map((feed, i) => ({
    source: feed.name,
    title: `${feed.name} direct ${i}`,
    link: `https://direct.example/${encodeURIComponent(feed.name)}`,
    pubDate: new Date(Date.UTC(2026, 9, 29, 13, 0, i)),
  })));
  mocks.isDesktopRuntime.mockReturnValue(false);
  mocks.toggles = {};
});

describe('web makes no direct feed requests', () => {
  it('leaves a preset panel loading, not empty, while the digest is pending', async () => {
    const { loader, statusPanel, panels } = await makeLoader();

    await loader.loadNewsCategory('politics', feeds(['A', 'B']), null, false, PENDING);

    expect(panels.politics.renderNews).not.toHaveBeenCalled();
    expect(statusPanel.updateFeed).not.toHaveBeenCalled();
  });

  it('leaves a preset panel empty when no digest carries its category (AE5)', async () => {
    const { loader, statusPanel } = await makeLoader();

    const items = await loader.loadNewsCategory('politics', feeds(['A', 'B']), null, false, OPTIONS);

    expect(items).toEqual([]);
    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
    expect(statusPanel.updateFeed).toHaveBeenCalledWith('Politics', { status: 'error', errorMessage: 'Digest unavailable' });
  });

  it('even with the switch on, for preset, cross-edition and intel panels', async () => {
    mocks.toggles.newsOutageFallback = true;
    const { loader } = await makeLoader();

    await loader.loadNewsCategory('politics', feeds(['A']), null, false, OPTIONS);
    await loader.loadNewsCategory('markets', feeds(['Finance Wire']), null, true, OPTIONS);
    await loader.loadIntelNews(null, OPTIONS);

    expect(mocks.fetchCategoryFeeds).not.toHaveBeenCalled();
  });
});
