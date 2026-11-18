/**
 * Trade policy intelligence service.
 * WTO MFN baselines, trade flows/barriers, and US customs/effective tariff context.
 */

import { getRpcBaseUrl } from '@/services/rpc-client';
import { IS_EMBEDDED_PREVIEW } from '@/utils/embedded-preview';
import type { GetTradeRestrictionsResponse, GetTariffTrendsResponse, GetTradeFlowsResponse, GetTradeBarriersResponse, GetCustomsRevenueResponse, ListComtradeFlowsResponse, ComtradeFlowRecord, TradeRestriction, TariffDataPoint, EffectiveTariffRate, TradeFlowRecord, TradeBarrier, CustomsRevenueMonth } from '@/generated/client/worldmonitor/trade/v1/service_client';
import { createCircuitBreaker } from '@/utils/circuit-breaker';
import { isFeatureAvailable } from '../runtime-config';
import { getHydratedData } from '@/services/bootstrap';
import { TradeServiceClient } from '@/services/generated-rpc-clients';

// Re-export types for consumers
export type { TradeRestriction, TariffDataPoint, EffectiveTariffRate, TradeFlowRecord, TradeBarrier, CustomsRevenueMonth, ComtradeFlowRecord };
export type {
  GetTradeRestrictionsResponse,
  GetTariffTrendsResponse,
  GetTradeFlowsResponse,
  GetTradeBarriersResponse,
  GetCustomsRevenueResponse,
  ListComtradeFlowsResponse,
};

const client = new TradeServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) });

const restrictionsBreaker = createCircuitBreaker<GetTradeRestrictionsResponse>({ name: 'WTO Restrictions', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
// Premium endpoints: persistCache:false so a pro user's response is NOT
// written to localStorage/IndexedDB where a later free / signed-out session
// on the same browser would read it back without re-authenticating.
const tariffsBreaker = createCircuitBreaker<GetTariffTrendsResponse>({ name: 'WTO Tariffs', cacheTtlMs: 30 * 60 * 1000, persistCache: false });
const flowsBreaker = createCircuitBreaker<GetTradeFlowsResponse>({ name: 'WTO Flows', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const barriersBreaker = createCircuitBreaker<GetTradeBarriersResponse>({ name: 'WTO Barriers', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const revenueBreaker = createCircuitBreaker<GetCustomsRevenueResponse>({ name: 'Treasury Revenue', cacheTtlMs: 30 * 60 * 1000, persistCache: true });
const comtradeBreaker = createCircuitBreaker<ListComtradeFlowsResponse>({ name: 'Comtrade Flows', cacheTtlMs: 6 * 60 * 60 * 1000, persistCache: false });

const emptyRestrictions: GetTradeRestrictionsResponse = { restrictions: [], fetchedAt: '', upstreamUnavailable: false };
// The client-side empty is a local degrade (feature off, breaker open, thrown
// request), not a server verdict, so it carries the UNSPECIFIED zero value.
// Only the handler names an actual coverage gap or fault.
const emptyTariffs: GetTariffTrendsResponse = {
  datapoints: [], fetchedAt: '', upstreamUnavailable: false,
  unavailableReason: 'TARIFF_TREND_UNAVAILABLE_REASON_UNSPECIFIED',
  coverageStartYear: 0, coverageEndYear: 0,
};
const emptyFlows: GetTradeFlowsResponse = {
  flows: [], fetchedAt: '', upstreamUnavailable: false,
  unavailableReason: 'TRADE_FLOW_UNAVAILABLE_REASON_UNSPECIFIED',
  coverageStartYear: 0, coverageEndYear: 0,
};
const emptyBarriers: GetTradeBarriersResponse = { barriers: [], fetchedAt: '', upstreamUnavailable: false };
const emptyRevenue: GetCustomsRevenueResponse = { months: [], fetchedAt: '', upstreamUnavailable: false };
const emptyComtrade: ListComtradeFlowsResponse = { flows: [], fetchedAt: '', upstreamUnavailable: false };

export async function fetchTradeRestrictions(countries: string[] = [], limit = 50): Promise<GetTradeRestrictionsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyRestrictions;
  try {
    return await restrictionsBreaker.execute(async () => {
      return client.getTradeRestrictions({ countries, limit });
    }, emptyRestrictions, { shouldCache: r => (r.restrictions?.length ?? 0) > 0 });
  } catch {
    return emptyRestrictions;
  }
}

export async function fetchTariffTrends(reportingCountry: string, partnerCountry: string, productSector = '', years = 10): Promise<GetTariffTrendsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyTariffs;
  // /pro live-preview iframe: no Clerk session → guaranteed 401 → breaker
  // would fall through to emptyTariffs anyway. Short-circuit to silence the
  // console noise this path causes on the embedding /pro page.
  if (IS_EMBEDDED_PREVIEW) return emptyTariffs;
  try {
    return await tariffsBreaker.execute(async () => {
      return client.getTariffTrends({ reportingCountry, partnerCountry, productSector, years });
    }, emptyTariffs, { shouldCache: r => (r.datapoints?.length ?? 0) > 0 });
  } catch {
    return emptyTariffs;
  }
}

export async function fetchTradeFlows(reportingCountry: string, partnerCountry: string, years = 10): Promise<GetTradeFlowsResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyFlows;
  try {
    return await flowsBreaker.execute(async () => {
      return client.getTradeFlows({ reportingCountry, partnerCountry, years });
    }, emptyFlows, { shouldCache: r => (r.flows?.length ?? 0) > 0 });
  } catch {
    return emptyFlows;
  }
}

export async function fetchTradeBarriers(countries: string[] = [], measureType = '', limit = 50): Promise<GetTradeBarriersResponse> {
  if (!isFeatureAvailable('wtoTrade')) return emptyBarriers;
  try {
    return await barriersBreaker.execute(async () => {
      return client.getTradeBarriers({ countries, measureType, limit });
    }, emptyBarriers, { shouldCache: r => (r.barriers?.length ?? 0) > 0 });
  } catch {
    return emptyBarriers;
  }
}

export async function fetchCustomsRevenue(): Promise<GetCustomsRevenueResponse> {
  const hydrated = getHydratedData('customsRevenue') as GetCustomsRevenueResponse | undefined;
  if (hydrated?.months?.length) {
    revenueBreaker.recordSuccess(hydrated);
    return hydrated;
  }

  try {
    return await revenueBreaker.execute(async () => {
      return client.getCustomsRevenue({});
    }, emptyRevenue, { shouldCache: r => (r.months?.length ?? 0) > 0 });
  } catch {
    return emptyRevenue;
  }
}

export async function fetchComtradeFlows(): Promise<ListComtradeFlowsResponse> {
  // /pro live-preview iframe: see fetchTariffTrends comment above.
  if (IS_EMBEDDED_PREVIEW) return emptyComtrade;
  try {
    return await comtradeBreaker.execute(async () => {
      return client.listComtradeFlows({ reporterCode: '', cmdCode: '', anomaliesOnly: false });
    }, emptyComtrade, { shouldCache: r => (r.flows?.length ?? 0) > 0 });
  } catch {
    return emptyComtrade;
  }
}
