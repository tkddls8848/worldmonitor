/**
 * Shared gateway logic for the per-domain API handlers.
 *
 * Personal fork: the loopback ingress and local API handle access. The gateway
 * routes; it does not authenticate, meter, rate-limit or record usage.
 *
 * dispatch():
 *   1. `.md` twin of an API route
 *   2. CORS, OPTIONS preflight and the origin allowlist
 *   3. route match, POST→GET compatibility, 404/405
 *   4. request validation (serverOptions.validateRequest, in the generated handler)
 *   5. country-history window binding and the handler call
 *   6. response headers, cache tier, JMESPath projection and ETag
 *   7. HEAD (in the returned handler)
 */

import { bindCountryHistoryAccess } from './_shared/country-history-access';
import { createRouter, toHeadResponse, type RouteDescriptor } from './router';
import { getCorsHeaders, getOriginDeniedCorsHeaders, isDisallowedOrigin, isAllowedOrigin } from './cors';
import { PRO_FRESH_CACHE_RPC_PATHS } from '../src/shared/pro-fresh-rpc';
import { mapErrorToResponse } from './error-mapper';
import {
  drainResponseHeaders,
  drainRetryableResponse,
  drainSuccessStatusOverride,
  drainUnservedLlmResponse,
} from './_shared/response-headers';
import {
  appendDeprecationPolicyLink,
  appendDeprecationPolicyLinkToRecord,
} from './_shared/deprecation-policy';
import {
  REST_ATTRIBUTION_EXPRESSIONS,
  buildAttributionRider,
  mergeAttributionRider,
} from '../shared/attribution-rider';
import {
  enforceRestProjectionOutputLimit,
  projectJsonResponse,
} from './_shared/response-projection';
import { getRpcNoStoreReasonFromJson } from './_shared/cache-contract';
import type { ServerOptions } from '../src/generated/server/worldmonitor/seismology/v1/service_server';
import { validateGeneratedRequest } from './request-validator';
import {
  buildMarkdownTwinResponse,
  isMarkdownTwinPath,
} from '../api/_md-url-twin';

export const serverOptions: ServerOptions = {
  onError: mapErrorToResponse,
  validateRequest: validateGeneratedRequest,
};

/** Country-history window for the single owner: the full year, always. */
const COUNTRY_HISTORY_DAYS = 365;

// --- Edge cache tier definitions ---
// NOTE: This map is shared across all domain bundles (~3KB). Kept centralised for
// single-source-of-truth maintainability; the size is negligible vs handler code.

type CacheTier = 'fast' | 'medium' | 'slow' | 'slow-browser' | 'live-browser' | 'static' | 'daily' | 'no-store' | 'live';

// Three-tier caching: browser (max-age) → CF edge (s-maxage) → Vercel CDN (CDN-Cache-Control).
// CF ignores Vary: Origin so it may pin a single ACAO value, but this is acceptable
// since production traffic is same-origin and preview deployments hit Vercel CDN directly.
//
// 'live' tier (60s) is for endpoints with strict freshness contracts — the
// energy-atlas live-tanker map layer requires position fixes to refresh on
// the order of one minute. Every shorter-than-medium tier is custom; we keep
// the existing tiers untouched so unrelated endpoints aren't impacted.
const TIER_HEADERS: Record<CacheTier, string> = {
  fast: 'public, max-age=60, s-maxage=300, stale-while-revalidate=60, stale-if-error=600',
  medium: 'public, max-age=120, s-maxage=600, stale-while-revalidate=120, stale-if-error=900',
  slow: 'public, max-age=300, s-maxage=1800, stale-while-revalidate=300, stale-if-error=3600',
  'slow-browser': 'max-age=300, stale-while-revalidate=60, stale-if-error=1800',
  'live-browser': 'private, max-age=30, stale-while-revalidate=60, stale-if-error=300',
  static: 'public, max-age=600, s-maxage=3600, stale-while-revalidate=600, stale-if-error=14400',
  daily: 'public, max-age=3600, s-maxage=14400, stale-while-revalidate=7200, stale-if-error=172800',
  'no-store': 'no-store',
  live: 'public, max-age=30, s-maxage=60, stale-while-revalidate=60, stale-if-error=300',
};

// Vercel CDN-specific cache TTLs — CDN-Cache-Control overrides Cache-Control for
// Vercel's own edge cache, so Vercel can still cache aggressively (and respects
// Vary: Origin correctly) while CF sees no public s-maxage and passes through.
const TIER_CDN_CACHE: Record<CacheTier, string | null> = {
  fast: 'public, s-maxage=600, stale-while-revalidate=300, stale-if-error=1200',
  medium: 'public, s-maxage=1200, stale-while-revalidate=600, stale-if-error=1800',
  slow: 'public, s-maxage=3600, stale-while-revalidate=900, stale-if-error=7200',
  'slow-browser': 'public, s-maxage=900, stale-while-revalidate=60, stale-if-error=1800',
  'live-browser': null,
  static: 'public, s-maxage=14400, stale-while-revalidate=3600, stale-if-error=28800',
  daily: 'public, s-maxage=86400, stale-while-revalidate=14400, stale-if-error=172800',
  'no-store': null,
  live: 'public, s-maxage=60, stale-while-revalidate=60, stale-if-error=300',
};

const RPC_CACHE_TIER: Record<string, CacheTier> = {
  '/api/world-overview/v1/get-world-overview-snapshot': 'daily',
  // Server cache owns enrichment lifetime; provider disablement must be immediate.
  '/api/cyber/v1/get-network-info': 'no-store',
  // 'live' tier — bbox-quantized + tanker-aware caching upstream of the
  // 60s in-handler cache, absorbing identical-bbox requests at the CDN
  // before they hit this Vercel function. Energy Atlas live-tanker layer.
  '/api/maritime/v1/get-vessel-snapshot': 'live',

  '/api/market/v1/list-market-quotes': 'medium',
  '/api/market/v1/list-crypto-quotes': 'medium',
  '/api/market/v1/list-crypto-sectors': 'slow',
  '/api/market/v1/list-defi-tokens': 'slow',
  '/api/market/v1/list-ai-tokens': 'slow',
  '/api/market/v1/list-other-tokens': 'slow',
  '/api/market/v1/list-commodity-quotes': 'medium',
  '/api/market/v1/get-physical-premiums': 'no-store',
  '/api/market/v1/get-physical-divergence-index': 'no-store',
  '/api/market/v1/list-stablecoin-markets': 'medium',
  '/api/market/v1/get-sector-summary': 'medium',
  '/api/market/v1/get-fear-greed-index': 'slow',
  '/api/market/v1/get-market-breadth-history': 'daily',
  '/api/market/v1/list-gulf-quotes': 'medium',
  '/api/market/v1/analyze-stock': 'slow',
  '/api/market/v1/get-stock-analysis-history': 'medium',
  '/api/market/v1/backtest-stock': 'slow',
  '/api/market/v1/list-stored-stock-backtests': 'medium',
  '/api/infrastructure/v1/list-service-statuses': 'slow',
  '/api/seismology/v1/list-earthquakes': 'fast',
  '/api/infrastructure/v1/list-internet-outages': 'slow',
  '/api/infrastructure/v1/list-internet-ddos-attacks': 'slow',
  '/api/infrastructure/v1/list-internet-traffic-anomalies': 'slow',
  '/api/forecast/v1/get-forecast-scorecard': 'fast',
  '/api/safety/v1/get-toronto-safety': 'slow',

  '/api/unrest/v1/list-unrest-events': 'slow',
  '/api/cyber/v1/list-cyber-threats': 'static',
  '/api/conflict/v1/list-acled-events': 'slow',
  '/api/military/v1/get-theater-posture': 'slow',
  '/api/intelligence/v1/get-country-signal-observations': 'no-store',
  '/api/military/v1/get-defense-industrial-base': 'daily',
  '/api/infrastructure/v1/get-temporal-baseline': 'slow',
  '/api/aviation/v1/list-airport-delays': 'static',
  '/api/aviation/v1/track-aircraft': 'no-store',
  '/api/aviation/v1/list-aircraft-emergencies': 'no-store',
  '/api/aviation/v1/search-flight-prices': 'medium',
  '/api/aviation/v1/search-google-flights': 'no-store',
  '/api/aviation/v1/search-google-dates': 'medium',
  '/api/aviation/v1/list-aviation-news': 'slow',
  '/api/market/v1/get-country-stock-index': 'slow',
  '/api/market/v1/get-price-history': 'static',

  '/api/natural/v1/list-natural-events': 'slow',
  '/api/wildfire/v1/list-fire-detections': 'static',
  '/api/maritime/v1/list-navigational-warnings': 'static',
  '/api/maritime/v1/list-ukmto-incidents': 'no-store',
  '/api/supply-chain/v1/get-china-corridor-control-towers': 'medium',
  '/api/supply-chain/v1/get-shipping-rates': 'daily',
  '/api/supply-chain/v1/list-pipelines': 'static',
  '/api/supply-chain/v1/get-pipeline-detail': 'static',
  '/api/supply-chain/v1/list-storage-facilities': 'static',
  '/api/supply-chain/v1/get-storage-facility-detail': 'static',
  '/api/supply-chain/v1/list-fuel-shortages': 'medium',
  '/api/supply-chain/v1/get-fuel-shortage-detail': 'medium',
  '/api/supply-chain/v1/list-energy-disruptions': 'medium',
  '/api/economic/v1/get-fred-series': 'static',
  '/api/economic/v1/get-bls-series': 'daily',
  '/api/economic/v1/get-energy-prices': 'static',
  '/api/research/v1/list-arxiv-papers': 'static',
  '/api/research/v1/list-trending-repos': 'static',
  '/api/giving/v1/get-giving-summary': 'static',
  '/api/intelligence/v1/get-country-intel-brief': 'static',
  // The canonical Railway projection refreshes every 15 minutes. Keep the
  // public composition route's Vercel TTL (10m on fast) inside that cadence so
  // the seeder cannot keep re-publishing a two-hour-old medium-tier response.
  '/api/intelligence/v1/get-china-decision-signals': 'fast',
  '/api/intelligence/v1/get-gdelt-topic-timeline': 'medium',
  '/api/climate/v1/list-climate-anomalies': 'daily',
  '/api/climate/v1/list-climate-disasters': 'daily',
  '/api/climate/v1/get-co2-monitoring': 'daily',
  '/api/climate/v1/get-ocean-ice-data': 'daily',
  '/api/climate/v1/list-climate-news': 'slow',
  '/api/climate/v1/list-reservoir-levels': 'daily',
  '/api/sanctions/v1/list-sanctions-pressure': 'daily',
  '/api/sanctions/v1/lookup-sanction-entity': 'no-store',
  '/api/radiation/v1/list-radiation-observations': 'slow',
  '/api/thermal/v1/list-thermal-escalations': 'slow',
  '/api/research/v1/list-tech-events': 'daily',
  '/api/military/v1/get-usni-fleet-report': 'daily',
  '/api/conflict/v1/list-ucdp-events': 'daily',
  '/api/conflict/v1/get-humanitarian-summary': 'daily',
  '/api/conflict/v1/list-iran-events': 'slow',
  '/api/displacement/v1/get-displacement-summary': 'daily',
  '/api/displacement/v1/get-internal-displacement': 'daily',
  '/api/displacement/v1/get-cross-border-movements': 'daily',
  '/api/displacement/v1/get-population-exposure': 'daily',
  '/api/economic/v1/get-bis-policy-rates': 'daily',
  '/api/economic/v1/get-bis-exchange-rates': 'daily',
  '/api/economic/v1/get-bis-credit': 'daily',
  '/api/trade/v1/get-tariff-trends': 'daily',
  '/api/trade/v1/get-bilateral-tariff': 'daily',
  '/api/trade/v1/get-us-import-duty': 'daily',
  '/api/trade/v1/get-trade-flows': 'daily',
  '/api/trade/v1/get-trade-barriers': 'daily',
  '/api/trade/v1/get-trade-restrictions': 'daily',
  '/api/trade/v1/get-customs-revenue': 'daily',
  '/api/trade/v1/list-comtrade-flows': 'daily',
  '/api/economic/v1/list-world-bank-indicators': 'daily',
  '/api/economic/v1/get-energy-capacity': 'daily',
  '/api/economic/v1/list-grocery-basket-prices': 'daily',
  '/api/economic/v1/list-fuel-prices': 'daily',
  '/api/economic/v1/get-fao-food-price-index': 'daily',
  '/api/economic/v1/get-food-prices': 'slow',
  '/api/economic/v1/get-crude-inventories': 'daily',
  '/api/economic/v1/get-nat-gas-storage': 'daily',
  '/api/economic/v1/get-eu-yield-curve': 'daily',
  // Daily macro seed. A miss returns unavailable:true, which the gateway
  // already keeps out of the shared cache.
  '/api/economic/v1/get-us-cpi-monthly': 'daily',
  '/api/economic/v1/get-us-treasury-par-yield-curve': 'daily',
  '/api/economic/v1/get-us-interest-rates': 'daily',
  '/api/economic/v1/get-world-cpi-monthly': 'daily',
  // Weekly seed of quarterly IMF/BIS sources. A miss returns unavailable:true.
  '/api/economic/v1/get-capital-flows': 'daily',
  // Daily yield-curve bundle. A miss returns unavailable:true, which the
  // gateway already keeps out of the shared cache.
  '/api/economic/v1/get-government-yield-curve': 'daily',
  '/api/supply-chain/v1/get-critical-minerals': 'daily',
  '/api/supply-chain/v1/get-mineral-production': 'daily',
  '/api/military/v1/get-aircraft-details': 'static',
  '/api/military/v1/get-wingbits-status': 'static',
  '/api/military/v1/get-wingbits-live-flight': 'no-store',

  '/api/military/v1/list-military-flights': 'slow',
  '/api/market/v1/list-etf-flows': 'slow',
  '/api/research/v1/list-hackernews-items': 'slow',
  '/api/intelligence/v1/get-country-risk': 'slow',
  '/api/intelligence/v1/get-country-history': 'no-store',
  // `medium` rather than the sibling `slow`, because the response can carry
  // degraded=true and an hour of shared edge cache would pin a transient
  // upstream failure long after it healed.
  '/api/intelligence/v1/get-country-coverage': 'medium',
  '/api/intelligence/v1/get-risk-scores': 'slow',
  // Live, not slow: the relay publishes a BestTime reading every 15 min, and
  // an hour of CDN cache kept venues CLOSED long after they opened.
  '/api/intelligence/v1/get-pizzint-status': 'live',
  '/api/intelligence/v1/classify-event': 'static',
  '/api/intelligence/v1/search-gdelt-documents': 'slow',
  '/api/infrastructure/v1/get-cable-health': 'slow',
  '/api/positive-events/v1/list-positive-geo-events': 'slow',

  '/api/military/v1/list-military-bases': 'daily',
  '/api/economic/v1/get-macro-signals': 'medium',
  '/api/economic/v1/get-national-debt': 'daily',
  '/api/prediction/v1/list-prediction-markets': 'medium',
  '/api/forecast/v1/get-forecasts': 'medium',
  '/api/forecast/v1/get-simulation-package': 'slow',
  '/api/forecast/v1/get-simulation-outcome': 'slow',
  '/api/supply-chain/v1/get-chokepoint-status': 'fast',
  '/api/supply-chain/v1/get-chokepoint-history': 'slow',
  // Fast, not slow: the digest is rebuilt into Redis every 15 min, and a CDN
  // holding one body for an hour made the CDN the freshness floor.
  '/api/news/v1/list-feed-digest': 'fast',
  '/api/news/v1/list-country-headlines': 'fast',
  '/api/news/v1/list-media-perspective': 'fast',
  '/api/news/v1/list-news-pool': 'fast',
  // #9796: cached feed rows for a panel's enabled sources below the category cap.
  '/api/news/v1/list-source-items': 'fast',
  '/api/news/v1/list-label-changes': 'fast',
  // #9093 operator queue: never cached, it is gated by a secret header.
  '/api/news/v1/list-error-reports': 'no-store',
  // #9094: per-claim fact-check lookup; the CDN key includes the claim.
  '/api/news/v1/search-fact-checks': 'slow',
  // /verify claim search over the feed caches; the CDN key includes the claim.
  '/api/news/v1/search-claim-headlines': 'fast',
  '/api/intelligence/v1/get-country-facts': 'daily',
  '/api/intelligence/v1/list-security-advisories': 'slow',
  '/api/intelligence/v1/list-satellites': 'static',
  '/api/intelligence/v1/list-gps-interference': 'slow',
  '/api/intelligence/v1/list-cross-source-signals': 'medium',
  '/api/intelligence/v1/list-oref-alerts': 'fast',
  '/api/intelligence/v1/get-company-enrichment': 'slow',
  '/api/intelligence/v1/list-company-signals': 'slow',
  '/api/intelligence/v1/search-sec-filings': 'medium',
  '/api/intelligence/v1/list-material-events': 'medium',
  '/api/news/v1/summarize-article-cache': 'slow',

  '/api/imagery/v1/search-imagery': 'static',
  '/api/orbital/v1/list-imaging-satellites': 'slow',

  '/api/infrastructure/v1/list-temporal-anomalies': 'medium',
  '/api/infrastructure/v1/get-ip-geo': 'no-store',
  '/api/infrastructure/v1/reverse-geocode': 'slow',
  '/api/infrastructure/v1/search-place': 'slow',
  '/api/infrastructure/v1/get-bootstrap-data': 'no-store',
  '/api/webcam/v1/get-webcam-image': 'no-store',
  '/api/webcam/v1/list-webcams': 'no-store',

  '/api/consumer-prices/v1/get-consumer-price-overview': 'slow',
  '/api/consumer-prices/v1/get-consumer-price-basket-series': 'slow',
  '/api/consumer-prices/v1/list-consumer-price-categories': 'slow',
  '/api/consumer-prices/v1/list-consumer-price-movers': 'slow',
  '/api/consumer-prices/v1/list-retailer-price-spreads': 'slow',
  '/api/consumer-prices/v1/get-consumer-price-freshness': 'slow',

  '/api/aviation/v1/get-youtube-live-stream-info': 'fast',

  '/api/market/v1/list-earnings-calendar': 'slow',
  '/api/market/v1/get-cot-positioning': 'slow',
  '/api/market/v1/get-gold-intelligence': 'slow',
  '/api/market/v1/get-hyperliquid-flow': 'medium',
  '/api/market/v1/get-insider-transactions': 'slow',
  '/api/economic/v1/get-economic-calendar': 'slow',
  '/api/economic/v1/get-china-macro-snapshot': 'slow',
  '/api/economic/v1/get-china-activity-nowcast': 'medium',
  // Daily seed (#9722); the CDN key carries the country_code, region_id and kind filters.
  '/api/economic/v1/get-no2-activity': 'slow',
  '/api/intelligence/v1/list-market-implications': 'slow',
  '/api/economic/v1/get-ecb-fx-rates': 'slow',
  '/api/economic/v1/get-eurostat-country-data': 'slow',
  '/api/economic/v1/get-eu-gas-storage': 'slow',
  '/api/economic/v1/get-oil-stocks-analysis': 'static',
  '/api/economic/v1/get-oil-inventories': 'slow',
  '/api/economic/v1/get-energy-crisis-policies': 'static',
  '/api/economic/v1/list-global-tenders': 'medium',
  '/api/economic/v1/get-eu-fsi': 'slow',
  '/api/economic/v1/get-economic-stress': 'slow',
  '/api/supply-chain/v1/get-shipping-stress': 'medium',
  '/api/supply-chain/v1/get-country-chokepoint-index': 'slow-browser',
  '/api/supply-chain/v1/get-bypass-options': 'slow-browser',
  '/api/supply-chain/v1/get-country-cost-shock': 'slow-browser',
  '/api/supply-chain/v1/get-country-products': 'slow-browser',
  // These responses differ by caller redistribution rights. The gateway cache
  // key does not vary on session/API-key audience, so they must never be stored.
  '/api/supply-chain/v1/get-country-vulnerabilities': 'no-store',
  '/api/supply-chain/v1/get-chokepoint-dependencies': 'no-store',
  '/api/supply-chain/v1/list-vulnerability-rankings': 'no-store',
  '/api/supply-chain/v1/get-multi-sector-cost-shock': 'slow-browser',
  '/api/supply-chain/v1/get-sector-dependency': 'slow-browser',
  '/api/supply-chain/v1/get-route-explorer-lane': 'slow-browser',
  '/api/supply-chain/v1/get-route-impact': 'slow-browser',
  // Scenario engine: list-scenario-templates is a compile-time constant catalog;
  // daily tier gives browser max-age=3600 matching the legacy /api/scenario/v1/templates
  // endpoint header.
  '/api/scenario/v1/list-scenario-templates': 'daily',
  '/api/scenario/v1/get-scenario-status': 'slow-browser',
  '/api/health/v1/list-disease-outbreaks': 'slow',
  '/api/intelligence/v1/get-country-energy-profile': 'slow',
  '/api/intelligence/v1/get-demographics-capability': 'slow',
  '/api/intelligence/v1/compute-energy-shock': 'fast',
  '/api/intelligence/v1/get-country-port-activity': 'slow',
  '/api/intelligence/v1/get-regional-snapshot': 'slow',
  '/api/intelligence/v1/get-regime-history': 'slow',
  '/api/intelligence/v1/get-regional-brief': 'slow',
  // Historical intelligence memory (#5694) — the timeline is a generated GET
  // and therefore requires an explicit gateway cache tier. The two semantic
  // reads are POSTs and cache successful results inside their handlers.
  '/api/intelligence/v1/get-intel-timeline': 'slow',
  '/api/supply-chain/v1/get-food-stocks': 'slow',
  '/api/scorecard/v1/get-five-factor-scorecard': 'slow',
  '/api/scorecard/v1/list-five-factor-scorecards': 'slow',
  '/api/scorecard/v1/get-bloc-scorecard': 'slow',

  // Partner-facing shipping/v2.
  '/api/v2/shipping/route-intelligence': 'slow-browser',
  // GET /webhooks is retired (410) with the webhook subsystem; the generated
  // route still exists until Phase 2 prunes proto/ and src/generated/.
  '/api/v2/shipping/webhooks': 'slow-browser',

  // Company Monitoring is account-private and remains unrouted until #6003.
  // Keep every generated read no-store so future activation cannot inherit a
  // shared CDN tier before its account isolation is proven end to end.
  '/api/company-monitoring/v1/get-company-coverage': 'no-store',
  '/api/company-monitoring/v1/get-company-material-event': 'no-store',
  '/api/company-monitoring/v1/get-company-monitoring-status': 'no-store',
  '/api/company-monitoring/v1/list-company-event-changes': 'no-store',
  '/api/company-monitoring/v1/list-company-event-impacts': 'no-store',
  '/api/company-monitoring/v1/list-monitored-companies': 'no-store',
};

// Routes the published OpenAPI document marks as needing no credentials
// (scripts/lib/openapi-codegen.mjs reads this block from source). The gateway
// itself no longer authenticates any route; see the file header.
export const PUBLIC_NO_AUTH_RPC_PATHS = new Set<string>([
  '/api/scorecard/v1/get-five-factor-scorecard',
  '/api/scorecard/v1/get-bloc-scorecard',
  '/api/scorecard/v1/list-five-factor-scorecards',
  '/api/intelligence/v1/get-china-decision-signals',
  // #9093 "Report an error": readers report without an account by design. The
  // gates are the handler's honeypot and validation and a bounded review queue
  // that refuses rather than evicts (the personal build has no per-IP limits). Reports are never applied automatically.
  '/api/news/v1/submit-error-report',
  // #9093 /trust page: public label history and today's counts. Read-only,
  // public coverage metadata; a visitor who lands on /trust directly has no
  // session cookie. Bounded by the 'fast' cache tier.
  '/api/news/v1/list-label-changes',
  // #9093 operator review. The gate is TRUST_REVIEW_SECRET, checked in the
  // handler (X-Trust-Review-Key, constant-time): unset → every call is 401.
  // A browser session would add nothing an operator secret does not already
  // prove, and the standalone review page has none. Fail-closed per-IP limits
  // bound guessing; list-error-reports is no-store.
  '/api/news/v1/list-error-reports',
  '/api/news/v1/review-error-report',
  // #9094 /verify: published fact-checks for a claim, cited with attribution.
  // Free like /verify (owner decision), which needs no account; bounded by a
  // fail-closed per-IP limit and a day-long per-claim cache of the upstream.
  '/api/news/v1/search-fact-checks',
  // /verify: the fresh headlines that share a claim's words, read from the
  // RSS caches the digest already writes (no publisher fetch). Free like
  // /verify; bounded by a per-IP limit and the 'fast' CDN tier.
  '/api/news/v1/search-claim-headlines',
]);

export type GatewayCtx = { waitUntil: (p: Promise<unknown>) => void };

const POST_TO_GET_MAX_BODY_BYTES = 1_048_576;
const POST_TO_GET_MAX_ARRAY_VALUES_PER_KEY = 200;

export const REQUIRED_BBOX_QUERY_PARAMS = ['sw_lat', 'sw_lon', 'ne_lat', 'ne_lon'] as const;

// Issue #4595 is scoped to military RPCs whose handlers require bbox.
// Other bbox-capable RPCs support lookup/global modes and must not emit this diagnostic.
export const REQUIRED_BBOX_RPC_PATHS = [
  '/api/military/v1/list-military-bases',
  '/api/military/v1/list-military-flights',
] as const;

const REQUIRED_BBOX_RPC_PATH_SET = new Set<string>(REQUIRED_BBOX_RPC_PATHS);
const MILITARY_BBOX_DIAGNOSTIC_PATH_SET = new Set<string>(REQUIRED_BBOX_RPC_PATHS);

function isPostToGetCompatibleBodySize(headers: Headers): boolean {
  const rawContentLength = headers.get('Content-Length');
  if (rawContentLength === null || !/^\d+$/.test(rawContentLength)) return false;

  const contentLength = Number(rawContentLength);
  return Number.isSafeInteger(contentLength) && contentLength < POST_TO_GET_MAX_BODY_BYTES;
}

type PostToGetScalar = string | number | boolean;

function isPostToGetScalar(value: unknown): value is PostToGetScalar {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isPostToGetPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

type PostToGetCompatField =
  | { kind: 'scalar'; name: string; value: string }
  | { kind: 'array'; name: string; values: string[] };

type PostToGetCompatParse =
  | { status: 'ok'; fields: PostToGetCompatField[] }
  | { status: 'too_large' }
  | { status: 'malformed_json' }
  | { status: 'unsupported_body' }
  | { status: 'unsupported_value'; parameter: string }
  | { status: 'oversized_array'; parameter: string };

/**
 * Decode a legacy POST body into GET query fields.
 *
 * Empty / whitespace-only bodies stay on the silent GET fallback for stale
 * clients that POST with no payload. Any other body is all-or-nothing: a
 * JSON object of scalars and scalar arrays becomes query parameters; mixed
 * or nested values, non-object JSON, and malformed JSON return 400 without
 * applying a partial translation. Compatibility-body errors are only
 * returned when a GET handler exists for the path; unknown routes still
 * 404/405. Body-read failures return 400. The 1 MB byte cap and
 * 200-values-per-key cap from #3550 still bound expansion cost.
 */
function parsePostToGetCompatBody(bodyText: string): PostToGetCompatParse {
  if (new TextEncoder().encode(bodyText).byteLength >= POST_TO_GET_MAX_BODY_BYTES) {
    return { status: 'too_large' };
  }
  if (bodyText.trim().length === 0) {
    return { status: 'ok', fields: [] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 'malformed_json' };
  }

  if (!isPostToGetPlainObject(parsed)) {
    return { status: 'unsupported_body' };
  }

  const fields: PostToGetCompatField[] = [];
  for (const [name, value] of Object.entries(parsed)) {
    if (Array.isArray(value)) {
      if (value.length > POST_TO_GET_MAX_ARRAY_VALUES_PER_KEY) {
        return { status: 'oversized_array', parameter: name };
      }
      const values: string[] = [];
      for (const item of value) {
        if (!isPostToGetScalar(item)) {
          return { status: 'unsupported_value', parameter: name };
        }
        values.push(String(item));
      }
      fields.push({ kind: 'array', name, values });
      continue;
    }
    if (isPostToGetScalar(value)) {
      fields.push({ kind: 'scalar', name, value: String(value) });
      continue;
    }
    return { status: 'unsupported_value', parameter: name };
  }
  return { status: 'ok', fields };
}

function applyPostToGetCompatFields(searchParams: URLSearchParams, fields: PostToGetCompatField[]): void {
  for (const field of fields) {
    if (field.kind === 'scalar') {
      searchParams.set(field.name, field.value);
      continue;
    }
    for (const value of field.values) {
      searchParams.append(field.name, value);
    }
  }
}

function postToGetCompatErrorBody(parsed: Exclude<PostToGetCompatParse, { status: 'ok' }>): Record<string, unknown> {
  if (parsed.status === 'too_large') return { error: 'malformed_request' };
  if (parsed.status === 'malformed_json') return { error: 'Invalid JSON body for POST compatibility' };
  if (parsed.status === 'unsupported_body') return { error: 'Unsupported POST compatibility body' };
  if (parsed.status === 'oversized_array') {
    return {
      error: 'Too many values for POST compatibility parameter',
      parameter: parsed.parameter,
      maxValues: POST_TO_GET_MAX_ARRAY_VALUES_PER_KEY,
    };
  }
  return {
    error: 'Unsupported value for POST compatibility parameter',
    parameter: parsed.parameter,
  };
}

function getRequiredBboxQueryProblems(searchParams: URLSearchParams): { missing: string[]; invalid: string[]; allZero: boolean } {
  const absent: string[] = [];
  const invalid: string[] = [];
  const values: number[] = [];

  for (const param of REQUIRED_BBOX_QUERY_PARAMS) {
    const raw = searchParams.get(param);
    if (raw == null) {
      absent.push(param);
      continue;
    }
    if (raw.trim() === '') {
      invalid.push(param);
      continue;
    }
    const value = Number(raw);
    if (!Number.isFinite(value)) {
      invalid.push(param);
      continue;
    }
    values.push(value);
  }

  const missing = absent.length === REQUIRED_BBOX_QUERY_PARAMS.length ? [...REQUIRED_BBOX_QUERY_PARAMS] : [];
  return {
    missing,
    invalid,
    allZero: absent.length === 0 && invalid.length === 0 && values.every((value) => value === 0),
  };
}

type RequiredBboxDiagnostic = {
  status: 'missing' | 'invalid';
  missing: string[];
  invalid: string[];
};

function getRequiredBboxDiagnostic(request: Request, pathname: string): RequiredBboxDiagnostic | null {
  if (!REQUIRED_BBOX_RPC_PATH_SET.has(pathname)) return null;

  const { searchParams } = new URL(request.url);
  const { missing, invalid, allZero } = getRequiredBboxQueryProblems(searchParams);
  if (missing.length === 0 && invalid.length === 0 && !allZero) return null;

  return {
    status: missing.length > 0 ? 'missing' : 'invalid',
    missing,
    invalid: allZero ? [...REQUIRED_BBOX_QUERY_PARAMS] : invalid,
  };
}

function attachRequiredBboxDiagnosticHeaders(
  headers: Headers,
  pathname: string,
  diagnostic: RequiredBboxDiagnostic | null,
): void {
  if (!diagnostic) return;
  headers.set('X-WorldMonitor-Bbox', diagnostic.status);
  if (diagnostic.missing.length > 0) headers.set('X-WorldMonitor-Bbox-Missing', diagnostic.missing.join(','));
  if (diagnostic.invalid.length > 0) headers.set('X-WorldMonitor-Bbox-Invalid', diagnostic.invalid.join(','));
  if (MILITARY_BBOX_DIAGNOSTIC_PATH_SET.has(pathname)) {
    // Issue #4595 explicitly requested the military alias; keep it as a stable consumer affordance.
    headers.set('X-Military-Bbox', diagnostic.status);
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 1 && value.charCodeAt(end - 1) === 47) end -= 1;
  return end === value.length ? value : value.slice(0, end);
}

// The only caller header a `.md` twin's in-process sibling request carries:
// the Origin the CORS allowlist checks.
const MARKDOWN_TWIN_CALLER_HEADERS = ['origin'] as const;

const COUNTRY_HISTORY_PATH = '/api/intelligence/v1/get-country-history';

/**
 * Creates the request handler for a single domain's routes.
 *
 * The signature is unchanged from the hosted gateway; callers that still pass
 * auth-related options get them ignored.
 */
export function createDomainGateway(
  routes: RouteDescriptor[],
  ..._ignoredAuthOptions: unknown[]
): (req: Request, ctx?: GatewayCtx) => Promise<Response> {
  const router = createRouter(routes);

  async function dispatch(originalRequest: Request, ctx?: GatewayCtx): Promise<Response> {
    const originalPathname = new URL(originalRequest.url).pathname;

    // 1. `.md` twin. The sibling is dispatched back through this gateway
    // in-process, so the origin check runs exactly as on a direct call (#4724).
    if (
      originalPathname.startsWith('/api/') &&
      isMarkdownTwinPath(originalPathname) &&
      (originalRequest.method === 'GET' || originalRequest.method === 'HEAD')
    ) {
      return serveMarkdownTwin(originalRequest, originalPathname, ctx);
    }

    let request = originalRequest;
    const rawPathname = originalPathname;
    const pathname = stripTrailingSlashes(rawPathname);

    // 2. CORS. Fail closed on CORS-header generation errors: omit CORS headers
    // and surface a 500 so the browser blocks any cross-origin read (#3705).
    let corsHeaders: Record<string, string>;
    try {
      corsHeaders = isDisallowedOrigin(request)
        ? getOriginDeniedCorsHeaders(request)
        : getCorsHeaders(request);
    } catch (err) {
      console.error('[gateway] CORS header generation failed', err);
      return new Response(JSON.stringify({ error: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      });
    }

    // RFC 9745 policy discovery on every CORS-bearing response, including
    // 403/404/405 early returns.
    appendDeprecationPolicyLinkToRecord(corsHeaders);

    // OPTIONS preflight must succeed even for origins we refuse on the actual
    // request — otherwise the browser never sends POST/GET and origin_403 is
    // an opaque network error (#6411).
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Origin check — refuse with readable CORS so the browser can surface the
    // 403 instead of an opaque network error (#6411).
    if (isDisallowedOrigin(request)) {
      return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    // 3. Route matching — if POST doesn't match, convert to GET for stale clients.
    let matchedHandler = router.match(request);
    if (!matchedHandler && request.method === 'POST') {
      if (isPostToGetCompatibleBodySize(request.headers)) {
        const url = new URL(request.url);
        const getProbe = new Request(url.toString(), { method: 'GET', headers: request.headers });
        const getProbeHandler = router.match(getProbe);
        if (getProbeHandler) {
          let compatErrorBody: Record<string, unknown> | null = null;
          let compatFields: PostToGetCompatField[] = [];
          try {
            const parsed = parsePostToGetCompatBody(await request.clone().text());
            if (parsed.status === 'ok') {
              compatFields = parsed.fields;
            } else {
              compatErrorBody = postToGetCompatErrorBody(parsed);
            }
          } catch {
            compatErrorBody = { error: 'malformed_request' };
          }
          if (compatErrorBody) {
            return new Response(JSON.stringify(compatErrorBody), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders },
            });
          }
          applyPostToGetCompatFields(url.searchParams, compatFields);
          const getReq = new Request(url.toString(), { method: 'GET', headers: request.headers });
          matchedHandler = router.match(getReq);
          if (matchedHandler) request = getReq;
        }
      }
    }
    if (!matchedHandler) {
      const allowed = router.allowedMethods(rawPathname);
      if (allowed.length > 0) {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
          status: 405,
          headers: { 'Content-Type': 'application/json', Allow: allowed.join(', '), ...corsHeaders },
        });
      }
      return new Response(JSON.stringify({ error: 'Not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json', ...corsHeaders },
      });
    }

    const requiredBboxDiagnostic = getRequiredBboxDiagnostic(request, pathname);

    // 4-5. Execute the handler (request validation runs inside the generated
    // handler through serverOptions) with a top-level error boundary.
    if (pathname === COUNTRY_HISTORY_PATH) {
      bindCountryHistoryAccess(request, COUNTRY_HISTORY_DAYS);
    }
    let response: Response;
    try {
      response = await matchedHandler(request);
    } catch (err) {
      console.error('[gateway] Unhandled handler error:', err);
      response = new Response(JSON.stringify({ message: 'Internal server error' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 6. Merge CORS + handler side-channel headers into the response. Every
    // side channel is keyed by the Request object the handler received.
    const mergedHeaders = new Headers(response.headers);
    for (const [key, value] of Object.entries(corsHeaders)) {
      mergedHeaders.set(key, value);
    }
    const extraHeaders = drainResponseHeaders(request);
    if (extraHeaders) {
      for (const [key, value] of Object.entries(extraHeaders)) {
        mergedHeaders.set(key, value);
      }
    }
    appendDeprecationPolicyLink(mergedHeaders);
    // Drained so a marker set by a handler cannot leak into a later decision;
    // nothing is metered any more, so the values themselves are unused.
    drainRetryableResponse(request);
    drainUnservedLlmResponse(request);
    attachRequiredBboxDiagnosticHeaders(mergedHeaders, pathname, requiredBboxDiagnostic);

    // Handler side-channel status override (setSuccessStatusOverride): applied
    // only when the handler actually produced a 200 on a POST — async-enqueue
    // endpoints (run-scenario) upgrade their success to 202 Accepted, while
    // thrown ApiError statuses always win. GET success flows are excluded:
    // the ETag/304 path below assumes 200.
    const statusOverride = drainSuccessStatusOverride(request);
    const finalStatus =
      statusOverride !== undefined && request.method === 'POST' && response.status === 200
        ? statusOverride
        : response.status;

    // For GET 200 responses: read body once for cache-header decisions + ETag
    if (response.status === 200 && (request.method === 'GET' || request.method === 'HEAD') && response.body) {
      const bodyBytes = await response.arrayBuffer();

      const bodyStr = new TextDecoder().decode(bodyBytes);
      const noStoreReason = getRpcNoStoreReasonFromJson(bodyStr, { pathname });

      const rpcName = pathname.split('/').pop() ?? '';
      const envOverride = process.env[`CACHE_TIER_OVERRIDE_${rpcName.replace(/-/g, '_').toUpperCase()}`] as CacheTier | undefined;
      const mapTier = RPC_CACHE_TIER[pathname];
      // The route's own declared tier (an env override wins over the map for
      // normal tiers). A map-declared no-store is a hard freshness floor that
      // not even an env override may downgrade (#6771).
      const declaredTier = (envOverride && envOverride in TIER_HEADERS ? envOverride : null) ?? mapTier;

      if (mergedHeaders.get('X-No-Cache') || noStoreReason || declaredTier === 'no-store' || mapTier === 'no-store') {
        mergedHeaders.set('Cache-Control', 'no-store');
        mergedHeaders.delete('CDN-Cache-Control');
        mergedHeaders.delete('Vercel-CDN-Cache-Control');
        mergedHeaders.set('X-Cache-Tier', 'no-store');
      } else {
        // The owner holds every plan benefit, including the Pro freshness tier.
        const isProFreshCacheRpc = PRO_FRESH_CACHE_RPC_PATHS.has(pathname);
        const tier: CacheTier = isProFreshCacheRpc ? 'live-browser' : declaredTier ?? 'medium';
        mergedHeaders.set('Cache-Control', TIER_HEADERS[tier]);
        // Only allow CDN caching for trusted origins. Keep per-origin ACAO and
        // Vary: Origin from corsHeaders so cache hits cannot cross origins.
        const reqOrigin = request.headers.get('origin') || '';
        const cdnCache = !isProFreshCacheRpc && isAllowedOrigin(reqOrigin) ? TIER_CDN_CACHE[tier] : null;
        mergedHeaders.delete('CDN-Cache-Control');
        mergedHeaders.delete('Vercel-CDN-Cache-Control');
        if (cdnCache) mergedHeaders.set('CDN-Cache-Control', cdnCache);
        mergedHeaders.set('X-Cache-Tier', tier);
      }
      mergedHeaders.delete('X-No-Cache');
      const responseSearchParams = new URL(request.url).searchParams;
      if (!responseSearchParams.has('_debug')) {
        mergedHeaders.delete('X-Cache-Tier');
      }

      // Universal optional JMESPath projection (REST parity with the MCP
      // server's `jmespath` tool argument). Applied to the JSON body BEFORE the
      // ETag hash so the ETag reflects the projected payload. GET-only.
      // See server/_shared/response-projection.ts + /docs/mcp-jmespath.
      let responseView = new Uint8Array(bodyBytes);
      const jmespathExpr = responseSearchParams.get('jmespath');
      if (jmespathExpr && (mergedHeaders.get('Content-Type') ?? '').includes('application/json')) {
        let projection = projectJsonResponse(bodyStr, jmespathExpr);
        if (projection.ok) {
          // Attribution accompaniment (shared/attribution-rider.ts): sources are
          // extracted from the UNPROJECTED body and merged AROUND the projected
          // document, so no expression can reach or remove them. Merged before
          // the ETag hash below, so the ETag covers the rider.
          const attributionExpr = REST_ATTRIBUTION_EXPRESSIONS[pathname];
          if (attributionExpr !== undefined) {
            let unprojected: unknown;
            try {
              unprojected = JSON.parse(bodyStr);
            } catch {
              unprojected = null;
            }
            const rider = buildAttributionRider(unprojected, attributionExpr);
            if (rider !== null) {
              const projectedBody = mergeAttributionRider(projection.body, rider);
              projection = enforceRestProjectionOutputLimit(projectedBody, unprojected);
            }
          }
        }
        if (!projection.ok) {
          return new Response(JSON.stringify(projection.envelope), {
            status: 400,
            headers: {
              ...corsHeaders,
              'Content-Type': 'application/json; charset=utf-8',
              'X-Content-Type-Options': 'nosniff',
              'Cache-Control': 'no-store',
            },
          });
        }
        responseView = new TextEncoder().encode(projection.body);
        // The projected body has a different length than the handler's — drop any
        // stale Content-Length so the runtime recomputes it.
        mergedHeaders.delete('Content-Length');
      }

      // FNV-1a inspired fast hash — good enough for cache validation
      let hash = 2166136261;
      const view = responseView;
      for (let i = 0; i < view.length; i++) {
        hash ^= view[i]!;
        hash = Math.imul(hash, 16777619);
      }
      const etag = `"${(hash >>> 0).toString(36)}-${view.length.toString(36)}"`;
      mergedHeaders.set('ETag', etag);

      const ifNoneMatch = request.headers.get('If-None-Match');
      if (ifNoneMatch === etag) {
        return new Response(null, { status: 304, headers: mergedHeaders });
      }

      return new Response(responseView, {
        status: response.status,
        statusText: response.statusText,
        headers: mergedHeaders,
      });
    }

    if (response.status === 200 && (request.method === 'GET' || request.method === 'HEAD')) {
      if (mergedHeaders.get('X-No-Cache')) {
        mergedHeaders.set('Cache-Control', 'no-store');
      }
      mergedHeaders.delete('X-No-Cache');
    }

    return new Response(response.body, {
      status: finalStatus,
      statusText: response.statusText,
      headers: mergedHeaders,
    });
  }

  // A `.md` twin of an API route. The sibling request never leaves this
  // process and carries only the caller's Origin, never a credential; its body
  // is cached by the sibling's rules.
  async function serveMarkdownTwin(caller: Request, markdownPath: string, ctx?: GatewayCtx): Promise<Response> {
    let corsHeaders: Record<string, string>;
    try {
      corsHeaders = isDisallowedOrigin(caller) ? getOriginDeniedCorsHeaders(caller) : getCorsHeaders(caller);
    } catch {
      // Fail closed: no CORS headers means a browser blocks any cross-origin
      // read. The sibling dispatch reports the same failure as its own 500.
      corsHeaders = {};
    }
    const callerOrigin = new URL(caller.url).origin;
    const dispatchSibling = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      // Only a route this gateway serves; never a network fetch. A redirect
      // onto any other path ends as a plain 404.
      if (url.origin !== callerOrigin || router.allowedMethods(stripTrailingSlashes(url.pathname)).length === 0) {
        return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
      }
      const headers = new Headers(init?.headers);
      for (const name of MARKDOWN_TWIN_CALLER_HEADERS) {
        const value = caller.headers.get(name);
        if (value) headers.set(name, value);
      }
      return gatewayHandler(new Request(url, { method: init?.method ?? 'GET', headers, signal: init?.signal }), ctx);
    }) as typeof fetch;
    return buildMarkdownTwinResponse(caller, markdownPath, dispatchSibling, {
      corsHeaders,
      inheritSiblingCacheControl: true,
    });
  }

  // 7. HEAD is GET without a body.
  const gatewayHandler = async function handler(originalRequest: Request, ctx?: GatewayCtx): Promise<Response> {
    const response = await dispatch(originalRequest, ctx);
    return originalRequest.method === 'HEAD' ? toHeadResponse(response) : response;
  };
  return gatewayHandler;
}
