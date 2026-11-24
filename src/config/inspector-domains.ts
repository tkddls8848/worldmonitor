import type { PanelConfig } from '@/types';

export type InspectorTabId = 'overview' | 'security' | 'markets' | 'news' | 'all';

export type MarketsSubFilter = 'all' | 'equities' | 'energy' | 'supply' | 'crypto';
export type NewsSubFilter = 'all' | 'regional' | 'topical' | 'tracking';

export interface InspectorTabDef {
  readonly id: InspectorTabId;
  readonly labelKo: string;
  readonly labelEn: string;
  readonly icon: string;
}

export const INSPECTOR_TABS: readonly InspectorTabDef[] = [
  { id: 'overview', labelKo: '요약', labelEn: 'Overview', icon: '◉' },
  { id: 'security', labelKo: '안보', labelEn: 'Security', icon: '🛡' },
  { id: 'markets', labelKo: '시장·에너지', labelEn: 'Markets', icon: '📈' },
  { id: 'news', labelKo: '뉴스·추적', labelEn: 'News', icon: '📰' },
  { id: 'all', labelKo: '전체', labelEn: 'All', icon: '⊞' },
] as const;

export const MARKETS_SUB_FILTERS: ReadonlyArray<{ readonly id: MarketsSubFilter; readonly labelKo: string; readonly labelEn: string }> = [
  { id: 'all', labelKo: '전체', labelEn: 'All' },
  { id: 'equities', labelKo: '증시·거시', labelEn: 'Macro & Stocks' },
  { id: 'energy', labelKo: '에너지·원자재', labelEn: 'Energy & Oil' },
  { id: 'supply', labelKo: '공급망·무역', labelEn: 'Supply & Trade' },
  { id: 'crypto', labelKo: '암호화폐', labelEn: 'Crypto' },
];

export const NEWS_SUB_FILTERS: ReadonlyArray<{ readonly id: NewsSubFilter; readonly labelKo: string; readonly labelEn: string }> = [
  { id: 'all', labelKo: '전체', labelEn: 'All' },
  { id: 'regional', labelKo: '지역 뉴스', labelEn: 'Regional' },
  { id: 'topical', labelKo: '주제 뉴스', labelEn: 'Topics' },
  { id: 'tracking', labelKo: '재난·추적', labelEn: 'Tracking' },
];

/** Curated first-screen Overview panels per variant (max ~7 scannable cards, no heavy video spinners). */
export const OVERVIEW_DEFAULT_PANELS: Readonly<Record<string, readonly string[]>> = {
  full: [
    'insights',
    'strategic-risk',
    'cii',
    'threat-timeline',
    'markets',
    'energy-complex',
    'latest-brief',
  ],
  tech: [
    'insights',
    'ai',
    'tech',
    'startups',
    'markets',
    'internet-disruptions',
    'latest-brief',
  ],
  finance: [
    'insights',
    'markets',
    'heatmap',
    'macro-signals',
    'fear-greed',
    'daily-market-brief',
    'latest-brief',
  ],
  commodity: [
    'insights',
    'commodities',
    'energy-complex',
    'gold-intelligence',
    'supply-chain',
    'markets',
    'latest-brief',
  ],
  energy: [
    'energy-risk-overview',
    'chokepoint-strip',
    'insights',
    'energy-complex',
    'oil-inventories',
    'hormuz-tracker',
    'latest-brief',
  ],
  happy: [
    'positive-feed',
    'progress',
    'counters',
    'spotlight',
    'breakthroughs',
    'digest',
  ],
};

/** Panels hosted in the bottom slide-up media & assistant tray for 1-click access without cluttering the first screen. */
export const BOTTOM_TRAY_PANELS = ['live-news', 'live-webcams', 'chat-analyst'] as const;
export type BottomTrayPanelId = (typeof BOTTOM_TRAY_PANELS)[number];

/** Canonical 6-domain panel sets covering all 168 unique panels across variants. */
const SECURITY_PANEL_KEYS = new Set<string>([
  'strategic-posture',
  'forecast',
  'cii',
  'strategic-risk',
  'threat-timeline',
  'intel',
  'gdelt-intel',
  'cascade',
  'military-correlation',
  'escalation-correlation',
  'economic-correlation',
  'disaster-correlation',
  'telegram-intel',
  'x-intel',
  'cross-source-signals',
  'chat-analyst',
  'thermal-escalation',
  'social-velocity',
  'sanctions-pressure',
  'ucdp-events',
  'security-advisories',
  'oref-sirens',
  'geo-hubs',
  'regional-intelligence',
  'deduction',
  'security',
  'policy',
  'ai-regulation',
]);

const MARKETS_EQUITIES_KEYS = new Set<string>([
  'markets',
  'heatmap',
  'stock-analysis',
  'stock-backtest',
  'daily-market-brief',
  'market-implications',
  'finance',
  'markets-news',
  'forex',
  'fx',
  'bonds',
  'centralbanks',
  'economic',
  'economic-news',
  'ipo',
  'macro-signals',
  'macro-tiles',
  'fear-greed',
  'aaii-sentiment',
  'market-breadth',
  'news-market-correlation',
  'fsi',
  'yield-curve',
  'earnings-calendar',
  'material-events',
  'economic-calendar',
  'cot-positioning',
  'liquidity-shifts',
  'positioning-247',
  'derivatives',
  'fintech',
  'fin-regulation',
  'institutional',
  'analysis',
  'polymarket',
  'wsb-ticker-scanner',
  'national-debt',
  'gulf-economies',
  'gcc-investments',
  'gccNews',
  'consumer-prices',
  'grocery-basket',
  'fao-food-price-index',
  'nq-pulse',
  'nq-catalysts',
  'nq-news',
]);

const MARKETS_ENERGY_KEYS = new Set<string>([
  'commodities',
  'commodities-news',
  'commodity-news',
  'energy-complex',
  'oil-inventories',
  'pipeline-status',
  'storage-facility-map',
  'fuel-shortages',
  'energy-disruptions',
  'energy-risk-overview',
  'grid-disruption-clock',
  'chokepoint-strip',
  'hormuz-tracker',
  'energy-crisis',
  'fuel-prices',
  'gold-intelligence',
  'gold-silver',
  'mining-news',
  'critical-minerals',
  'base-metals',
  'mining-companies',
  'commodity-regulation',
  'renewable',
]);

const MARKETS_SUPPLY_KEYS = new Set<string>([
  'supply-chain',
  'china-corridors',
  'china-activity-nowcast',
  'trade-policy',
  'global-procurement',
]);

const MARKETS_CRYPTO_KEYS = new Set<string>([
  'crypto',
  'crypto-news',
  'crypto-heatmap',
  'defi-tokens',
  'ai-tokens',
  'other-tokens',
  'etf-flows',
  'stablecoins',
]);

const NEWS_REGIONAL_KEYS = new Set<string>([
  'politics',
  'us',
  'europe',
  'middleeast',
  'africa',
  'latam',
  'asia',
]);

const NEWS_TOPICAL_KEYS = new Set<string>([
  'insights',
  'latest-brief',
  'live-news',
  'live-webcams',
  'windy-webcams',
  'energy',
  'gov',
  'thinktanks',
  'tech',
  'ai',
  'layoffs',
  'science',
  'climate-news',
  'startups',
  'vcblogs',
  'regionalStartups',
  'unicorns',
  'accelerators',
  'hardware',
  'cloud',
  'dev',
  'github',
  'funding',
  'producthunt',
  'events',
  'tech-hubs',
  'positive-feed',
  'progress',
  'counters',
  'spotlight',
  'breakthroughs',
  'digest',
  'species',
]);

const NEWS_TRACKING_KEYS = new Set<string>([
  'monitors',
  'satellite-fires',
  'displacement',
  'climate',
  'reservoir-levels',
  'population-exposure',
  'radiation-watch',
  'disease-outbreaks',
  'airline-intel',
  'world-clock',
  'tech-readiness',
  'ukmto-incidents',
  'toronto-safety',
  'giving',
  'internet-disruptions',
  'service-status',
]);

export function getMarketsSubFilterForPanel(panelId: string): MarketsSubFilter | null {
  if (MARKETS_EQUITIES_KEYS.has(panelId)) return 'equities';
  if (MARKETS_ENERGY_KEYS.has(panelId)) return 'energy';
  if (MARKETS_SUPPLY_KEYS.has(panelId)) return 'supply';
  if (MARKETS_CRYPTO_KEYS.has(panelId)) return 'crypto';
  return null;
}

export function getNewsSubFilterForPanel(panelId: string): NewsSubFilter | null {
  if (NEWS_REGIONAL_KEYS.has(panelId)) return 'regional';
  if (NEWS_TOPICAL_KEYS.has(panelId)) return 'topical';
  if (NEWS_TRACKING_KEYS.has(panelId)) return 'tracking';
  return null;
}

/** Primary domain tab that owns a panel (used when jumping to a panel from search/alerts). */
export function getInspectorTabForPanel(panelId: string, variant = 'full'): InspectorTabId {
  const overviewDefaults = OVERVIEW_DEFAULT_PANELS[variant] ?? OVERVIEW_DEFAULT_PANELS.full ?? [];
  if (overviewDefaults.includes(panelId)) return 'overview';
  if (SECURITY_PANEL_KEYS.has(panelId)) return 'security';
  if (getMarketsSubFilterForPanel(panelId) !== null) return 'markets';
  if (getNewsSubFilterForPanel(panelId) !== null) return 'news';
  return 'all';
}

export function getOverviewPanelKeys(
  variant: string,
  panelSettings: Record<string, PanelConfig>,
  pinnedOverrides?: readonly string[] | null,
): string[] {
  if (pinnedOverrides && pinnedOverrides.length > 0) {
    const validPins = pinnedOverrides.filter((k) => k !== 'map' && panelSettings[k]?.enabled === true);
    if (validPins.length > 0) return validPins;
  }
  const defaults = OVERVIEW_DEFAULT_PANELS[variant] ?? OVERVIEW_DEFAULT_PANELS.full ?? [];
  const enabledDefaults = defaults.filter((k) => panelSettings[k]?.enabled === true);
  if (enabledDefaults.length > 0) return enabledDefaults;
  return Object.entries(panelSettings)
    .filter(([k, cfg]) => k !== 'map' && cfg.enabled === true)
    .slice(0, 7)
    .map(([k]) => k);
}

/** Returns whether a panel should be visible in the right inspector for the active tab & sub-filter. */
export function isPanelVisibleInInspectorTab(
  panelId: string,
  tab: InspectorTabId,
  options: {
    variant: string;
    panelSettings: Record<string, PanelConfig>;
    pinnedOverview?: readonly string[] | null;
    marketsSubFilter?: MarketsSubFilter;
    newsSubFilter?: NewsSubFilter;
  },
): boolean {
  if (panelId === 'map') return false;
  if (tab === 'all') return true;
  if (tab === 'overview') {
    const overviewSet = new Set(getOverviewPanelKeys(options.variant, options.panelSettings, options.pinnedOverview));
    return overviewSet.has(panelId);
  }
  if (tab === 'security') {
    return SECURITY_PANEL_KEYS.has(panelId);
  }
  if (tab === 'markets') {
    const sub = getMarketsSubFilterForPanel(panelId);
    if (!sub) return false;
    const filter = options.marketsSubFilter ?? 'all';
    return filter === 'all' || filter === sub;
  }
  if (tab === 'news') {
    const sub = getNewsSubFilterForPanel(panelId);
    if (!sub) return false;
    const filter = options.newsSubFilter ?? 'all';
    return filter === 'all' || filter === sub;
  }
  return true;
}
