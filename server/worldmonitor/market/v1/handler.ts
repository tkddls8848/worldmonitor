/**
 * Market service handler -- thin composition of per-RPC modules.
 *
 * RPCs:
 *   - ListMarketQuotes      (Finnhub + Yahoo Finance for stocks/indices)
 *   - ListCommodityQuotes   (Yahoo Finance for commodity futures)
 *   - GetSectorSummary      (Finnhub for sector ETFs)
 *   - GetCountryStockIndex  (Yahoo Finance national stock indices)
 *   - GetPriceHistory       (Yahoo Finance dated daily closes for tracked symbols)
 *   - ListGulfQuotes        (Yahoo Finance GCC indices, currencies, oil)
 */

import type { MarketServiceHandler } from '../../../../src/generated/server/worldmonitor/market/v1/service_server';
import { listMarketQuotes } from './list-market-quotes';
import { listCommodityQuotes } from './list-commodity-quotes';
import { getSectorSummary } from './get-sector-summary';
import { getCountryStockIndex } from './get-country-stock-index';
import { getPriceHistory } from './get-price-history';
import { listGulfQuotes } from './list-gulf-quotes';
import { analyzeStock } from './analyze-stock';
import { getFearGreedIndex } from './get-fear-greed-index';
import { listEarningsCalendar } from './list-earnings-calendar';
import { getCotPositioning } from './get-cot-positioning';
import { getMarketBreadthHistory } from './get-market-breadth-history';
import { getGoldIntelligence } from './get-gold-intelligence';
import { getPerpPositioning } from './get-perp-positioning';
import { getPhysicalPremiums } from './get-physical-premiums';
import { getPhysicalDivergenceIndex } from './get-physical-divergence-index';

export const marketHandler: MarketServiceHandler = {
  listMarketQuotes,
  listCommodityQuotes,
  getPhysicalPremiums,
  getPhysicalDivergenceIndex,
  getSectorSummary,
  getCountryStockIndex,
  getPriceHistory,
  listGulfQuotes,
  analyzeStock,
  getFearGreedIndex,
  listEarningsCalendar,
  getCotPositioning,
  getMarketBreadthHistory,
  getGoldIntelligence,
  getPerpPositioning,
};
