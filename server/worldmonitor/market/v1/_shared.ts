/**
 * Shared helpers, types, and constants for the market service handler RPCs.
 */
import { normalizeStockSymbol } from '../../../../shared/stock-symbol';
import { getRelayBaseUrl, getRelayHeaders } from '../../../_shared/personal-providers';
export { getRelayBaseUrl, getRelayHeaders };
export { parseStringArray } from '../../../_shared/parse-string-array';

// ========================================================================
// Constants
// ========================================================================

export const UPSTREAM_TIMEOUT_MS = 10_000;

export function sanitizeSymbol(raw: string): string {
  return normalizeStockSymbol(raw);
}

// The Yahoo-only symbol list that used to live here was dead after #1684 (the
// handler became a pure seed read) and had drifted to a subset of the routing
// list the relay actually uses. `shared/stocks.json#yahooOnly` is the single
// source of truth; `./_quote-provider.ts` reads it to decide what Finnhub can
// serve.


// ========================================================================
// Types
// ========================================================================

export interface YahooChartResponse {
  chart: {
    result: Array<{
      meta: {
        regularMarketPrice: number;
        chartPreviousClose?: number;
        previousClose?: number;
        currency?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{ close?: (number | null)[] }>;
      };
    }>;
  };
}
