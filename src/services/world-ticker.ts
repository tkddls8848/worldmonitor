import type { TickerItem } from '@/types/world-overview';

type Instrument = { id: string; label: string; digits: number; unit?: string; aliases: string[]; source: 'marketQuotes' | 'commodityQuotes' | 'cryptoQuotes' | 'macroSignals' };
const instruments: Instrument[] = [
  { id: '^TNX', label: '미 10년물 금리', digits: 2, unit: '%', aliases: ['^TNX', 'US10Y', 'DGS10', 'treasury10y', 'us10y'], source: 'macroSignals' },
  { id: '^GSPC', label: 'S&P 500', digits: 0, aliases: ['^GSPC', 'SPX', 'SP500'], source: 'marketQuotes' },
  { id: '^IXIC', label: '나스닥', digits: 0, aliases: ['^IXIC', 'IXIC', 'NASDAQ'], source: 'marketQuotes' },
  { id: '^KS11', label: 'KOSPI', digits: 2, aliases: ['^KS11', 'KS11', 'KOSPI'], source: 'marketQuotes' },
  { id: 'CL=F', label: 'WTI', digits: 2, unit: '$', aliases: ['CL=F', 'WTI'], source: 'commodityQuotes' },
  { id: 'GC=F', label: '금', digits: 2, unit: '$', aliases: ['GC=F', 'GOLD'], source: 'commodityQuotes' },
  { id: 'KRW=X', label: '원/달러', digits: 2, aliases: ['KRW=X', 'USD/KRW', 'USDKRW'], source: 'marketQuotes' },
  { id: 'BTC-USD', label: '비트코인', digits: 0, unit: '$', aliases: ['BTC-USD', 'BTC'], source: 'cryptoQuotes' },
];
type SourceKey = Instrument['source'];
type TickerExtras = {
  fundingStress?: { ofrFsi?: { value: number; change1d: number | null } | null; sofr?: { rate: number; changeBp: number | null } | null } | null;
  gasFlows?: { origins: Partial<Record<'russia' | 'norway' | 'northAfrica' | 'lng', { gwhPerDay: number; change7dPct: number | null } | null>> } | null;
};
function asRecords(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object');
  if (!value || typeof value !== 'object') return [];
  const record = value as Record<string, unknown>;
  for (const key of ['quotes', 'data', 'signals', 'indicators', 'items']) if (Array.isArray(record[key])) return asRecords(record[key]);
  return [record];
}
function findQuote(src: Record<SourceKey, unknown>, instrument: Instrument): Record<string, unknown> | undefined {
  const records = asRecords(src[instrument.source]);
  const aliases = new Set(instrument.aliases.map((x) => x.toUpperCase()));
  return records.find((row) => [row.symbol, row.id, row.key, row.name, row.indicator].some((v) => typeof v === 'string' && aliases.has(v.toUpperCase())))
    ?? records.find((row) => instrument.aliases.some((alias) => Object.prototype.hasOwnProperty.call(row, alias)));
}
function numberFrom(row: Record<string, unknown> | undefined, keys: string[]): number | null {
  if (!row) return null;
  for (const key of keys) {
    const raw = row[key];
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
    if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) return Number(raw);
  }
  for (const value of Object.values(row)) {
    if (value && typeof value === 'object') {
      const nested = value as Record<string, unknown>;
      for (const key of keys) {
        const raw = nested[key];
        if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
        if (typeof raw === 'string' && raw.trim() && Number.isFinite(Number(raw))) return Number(raw);
      }
    }
  }
  return null;
}
export function buildTickerItems(src: { marketQuotes?: unknown; commodityQuotes?: unknown; cryptoQuotes?: unknown; macroSignals?: unknown }, extras: TickerExtras = {}): TickerItem[] {
  const all = src as Record<SourceKey, unknown>;
  const items: TickerItem[] = instruments.map((instrument) => {
    // A few feeds expose the Treasury yield as a market quote rather than a macro signal.
    const row = findQuote(all, instrument) ?? (instrument.id === '^TNX' ? findQuote({ ...all, macroSignals: src.marketQuotes }, instrument) : undefined);
    const sourceSymbol = row && [row.symbol, row.id, row.key].find((value): value is string => typeof value === 'string');
    return {
      id: sourceSymbol ?? instrument.id, label: instrument.label, value: numberFrom(row, ['price', 'value', 'yield', 'last', 'close', ...instrument.aliases]),
      changePct: numberFrom(row, ['changePct', 'changePercent', 'change', 'change_percent']), digits: instrument.digits,
      ...(instrument.unit ? { unit: instrument.unit } : {}),
    };
  });
  const stress = extras.fundingStress;
  if (stress?.ofrFsi) items.push({ id: 'ofr-fsi', label: 'OFR 스트레스', value: stress.ofrFsi.value, changePct: stress.ofrFsi.change1d, changeKind: 'abs', inverse: true, digits: 2 });
  if (stress?.sofr) items.push({ id: 'sofr', label: 'SOFR', value: stress.sofr.rate, changePct: stress.sofr.changeBp, changeKind: 'bp', digits: 2, unit: '%' });
  const gasLabels = { russia: 'EU 가스(러)', norway: 'EU 가스(노)', lng: 'LNG' } as const;
  for (const origin of ['russia', 'norway', 'lng'] as const) {
    const flow = extras.gasFlows?.origins[origin];
    if (flow) items.push({ id: `eu-gas-${origin}`, label: gasLabels[origin], value: flow.gwhPerDay, changePct: flow.change7dPct, changeKind: 'pct', digits: 0, unit: ' GWh/d' });
  }
  return items;
}

export function buildSupplementalTickerItems(extras: TickerExtras): TickerItem[] {
  return buildTickerItems({}, extras).slice(instruments.length);
}

const TICKER_STOCKS = [
  { symbol: '^TNX', name: 'US 10-Year Yield', display: 'US 10Y' },
  { symbol: '^GSPC', name: 'S&P 500', display: 'SPX' },
  { symbol: '^IXIC', name: 'NASDAQ Composite', display: 'COMP' },
  { symbol: '^KS11', name: 'KOSPI', display: 'KOSPI' },
  { symbol: 'KRW=X', name: 'USD/KRW', display: 'USDKRW' },
] as const;
const TICKER_COMMODITIES = [
  { symbol: 'CL=F', name: 'WTI Crude', display: 'WTI' },
  { symbol: 'GC=F', name: 'Gold', display: 'GOLD' },
];

/**
 * Ticker quotes through the market services (they read the bootstrap payload
 * first and fall back to the RPCs). The hydrated keys are consume-once, so the
 * first screen must not read them directly.
 */
export async function loadTickerItems(): Promise<TickerItem[]> {
  const { fetchMultipleStocks, fetchCommodityQuotes, fetchCrypto } = await import('@/services/market');
  const [stocks, commodities, crypto] = await Promise.allSettled([
    fetchMultipleStocks(TICKER_STOCKS),
    fetchCommodityQuotes(TICKER_COMMODITIES),
    fetchCrypto(),
  ]);
  const stockRows = stocks.status === 'fulfilled' ? stocks.value.data : [];
  return buildTickerItems({
    marketQuotes: stockRows,
    macroSignals: stockRows,
    commodityQuotes: commodities.status === 'fulfilled' ? commodities.value.data : [],
    cryptoQuotes: crypto.status === 'fulfilled' ? crypto.value : [],
  });
}
