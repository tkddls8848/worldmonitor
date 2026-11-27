import type { PanelConfig, MapLayers, DataSourceId } from '@/types';
import { SITE_VARIANT } from './variant';

// Iran-events domain sunset (war ended 2026-07). Default OFF: iranAttacks is
// disabled in every variant default so DEFAULT_MAP_LAYERS agrees with the gated
// layer registry (getAllowedLayerKeys strips it). Guarded so node:test — where
// import.meta.env is undefined — resolves it OFF at module load. See
// map-layer-definitions.ts and tests/browser-bundle-secret-guard (allowlist).
const IRAN_ATTACKS_ENABLED = typeof window !== 'undefined' && import.meta.env.VITE_ENABLE_IRAN_ATTACKS === 'true';

// ============================================
// FULL VARIANT (Geopolitical)
// ============================================
// Panel order matters! First panels appear at top of grid.
// Desired order: live-news, AI Insights, AI Strategic Posture, cii, strategic-risk, then rest
const FULL_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Map', enabled: true, priority: 1 },
  'live-news': { name: 'Live News', enabled: true, priority: 1 },
  insights: { name: 'AI Insights', enabled: true, priority: 1 },
  'threat-timeline': { name: 'Threat Timeline', enabled: true, priority: 1 },
  'strategic-posture': { name: 'AI Strategic Posture', enabled: true, priority: 1 },
  forecast: { name: 'AI Forecasts', enabled: true, priority: 1 },
  cii: { name: 'Country Instability', enabled: true, priority: 1 },
  'strategic-risk': { name: 'Strategic Risk Overview', enabled: true, priority: 1 },
  intel: { name: 'Intel Feed', enabled: true, priority: 1 },
  'gdelt-intel': { name: 'Live Intelligence', enabled: true, priority: 1 },
  cascade: { name: 'Infrastructure Cascade', enabled: true, priority: 1 },
  'military-correlation': { name: 'Force Posture', enabled: true, priority: 2 },
  'escalation-correlation': { name: 'Escalation Monitor', enabled: true, priority: 2 },
  'economic-correlation': { name: 'Economic Warfare', enabled: true, priority: 2 },
  'disaster-correlation': { name: 'Disaster Cascade', enabled: true, priority: 2 },
  politics: { name: 'World News', enabled: true, priority: 1 },
  us: { name: 'United States', enabled: true, priority: 1 },
  europe: { name: 'Europe', enabled: true, priority: 1 },
  middleeast: { name: 'Middle East', enabled: true, priority: 1 },
  africa: { name: 'Africa', enabled: true, priority: 1 },
  latam: { name: 'Latin America', enabled: true, priority: 1 },
  asia: { name: 'Asia-Pacific', enabled: true, priority: 1 },
  energy: { name: 'Energy & Resources', enabled: true, priority: 1 },
  gov: { name: 'Government', enabled: true, priority: 1 },
  thinktanks: { name: 'Think Tanks', enabled: true, priority: 1 },
  polymarket: { name: 'Predictions', enabled: true, priority: 1 },
  commodities: { name: 'Metals & Materials', enabled: true, priority: 1 },
  'energy-complex': { name: 'Energy Complex', enabled: true, priority: 1 },
  'oil-inventories': { name: 'Oil Inventories', enabled: true, priority: 60 },
  markets: { name: 'Markets', enabled: true, priority: 1 },
  'daily-market-brief': { name: 'Daily Market Brief', enabled: true, priority: 1 },
  'chat-analyst': { name: 'WM Analyst', enabled: true, priority: 1 },
  economic: { name: 'Macro Stress', enabled: true, priority: 1 },
  'global-procurement': { name: 'Global Procurement', enabled: true, priority: 1 },
  'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1 },
  'supply-chain': { name: 'Supply Chain', enabled: true, priority: 1 },
  'china-corridors': { name: 'China Logistics Corridors', enabled: true, priority: 1 },
  'china-activity-nowcast': { name: 'China Activity Nowcast', enabled: true, priority: 1 },
  finance: { name: 'Financial', enabled: true, priority: 1 },
  tech: { name: 'Technology', enabled: true, priority: 2 },
  heatmap: { name: 'Sector Heatmap', enabled: true, priority: 2 },
  ai: { name: 'AI/ML', enabled: true, priority: 2 },
  layoffs: { name: 'Layoffs Tracker', enabled: true, priority: 2 },
  // Opt-in news panel (2026-10-17 audit); its feeds also widen /verify claim search.
  science: { name: 'Science', enabled: false, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
  'latest-brief': { name: 'Latest Brief', enabled: true, priority: 1 },
  'satellite-fires': { name: 'Fires', enabled: true, priority: 2 },
  'macro-signals': { name: 'Market Regime', enabled: true, priority: 2 },
  'fear-greed': { name: 'Fear & Greed', enabled: true, priority: 2 },
  'market-breadth': { name: 'Market Breadth', enabled: true, priority: 2 },
  'news-market-correlation': { name: 'News ↔ Markets', enabled: true, priority: 1 },
  'macro-tiles': { name: 'Macro Indicators', enabled: false, priority: 2 },
  'fsi': { name: 'Financial Stress', enabled: false, priority: 2 },
  'yield-curve': { name: 'Yield Curve', enabled: false, priority: 2 },
  'economic-calendar': { name: 'Economic Calendar', enabled: false, priority: 2 },
  'cot-positioning': { name: 'COT Positioning', enabled: true, priority: 2 },
  'liquidity-shifts': { name: 'Liquidity Shifts', enabled: true, priority: 2 },
  'positioning-247': { name: '24/7 Positioning', enabled: true, priority: 2 },
  'gold-intelligence': { name: 'Gold Intelligence', enabled: true, priority: 60 },
  'hormuz-tracker': { name: 'Hormuz Trade Tracker', enabled: true, priority: 2 },
  'energy-crisis': { name: 'Energy Crisis Tracker', enabled: true, priority: 2 },
  'pipeline-status': { name: 'Oil & Gas Pipeline Status', enabled: true, priority: 2 },
  'storage-facility-map': { name: 'Strategic Storage Atlas', enabled: true, priority: 2 },
  'fuel-shortages': { name: 'Global Fuel Shortage Registry', enabled: true, priority: 2 },
  'energy-disruptions': { name: 'Energy Disruptions Log', enabled: true, priority: 2 },
  'energy-risk-overview': { name: 'Global Energy Risk Overview', enabled: false, priority: 2 },
  'gulf-economies': { name: 'Gulf Economies', enabled: false, priority: 2 },
  'consumer-prices': { name: 'Consumer Prices', enabled: false, priority: 2 },
  'grocery-basket': { name: 'Grocery Index', enabled: false, priority: 2 },
  // Distinct from the `forex` key, which is an RSS news feed, not a rate
  // surface. Opt-in per #6199; being per-variant, it can go default-on in
  // FINANCE_PANELS later without changing any other variant.
  fx: { name: 'FX Rates', enabled: false, priority: 2 },
  'fuel-prices': { name: 'Fuel Prices', enabled: false, priority: 2 },
  'fao-food-price-index': { name: 'FAO Food Price Index', enabled: false, priority: 2 },
  'ucdp-events': { name: 'UCDP Conflict Events', enabled: true, priority: 2 },
  'disease-outbreaks': { name: 'Disease Outbreaks', enabled: true, priority: 2 },
  displacement: { name: 'UNHCR Displacement', enabled: true, priority: 2 },
  'ukmto-incidents': { name: 'UKMTO Incidents', enabled: false, priority: 2 },
  climate: { name: 'Climate Anomalies', enabled: true, priority: 2 },
  'reservoir-levels': { name: 'Strategic Water Levels', enabled: false, priority: 2 },
  'climate-news': { name: 'Climate News', enabled: false, priority: 2 },
  'population-exposure': { name: 'Population Exposure', enabled: true, priority: 2 },
  'security-advisories': { name: 'Security Advisories', enabled: true, priority: 2 },
  'service-status': { name: 'Service Status', enabled: false, priority: 2 },
  'internet-disruptions': { name: 'Internet Disruptions', enabled: false, priority: 2 },
  'sanctions-pressure': { name: 'Sanctions Pressure', enabled: true, priority: 2 },
  'radiation-watch': { name: 'Radiation Watch', enabled: true, priority: 2 },
  'thermal-escalation': { name: 'Thermal Escalation', enabled: true, priority: 2 },
  'oref-sirens': { name: 'Israel Sirens', enabled: true, priority: 2 },
  'airline-intel': { name: 'Airline Intelligence', enabled: true, priority: 2 },
  'tech-readiness': { name: 'Tech Readiness Index', enabled: true, priority: 2 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 2 },
  'national-debt': { name: 'Global Debt Clock', enabled: true, priority: 2 },
  'cross-source-signals': { name: 'Cross-Source Signals', enabled: true, priority: 2 },
  'market-implications': { name: 'AI Market Implications', enabled: true, priority: 1 },
  'regional-intelligence': { name: 'Regional Intelligence', enabled: false, priority: 1 },
  'deduction': { name: 'Deduct Situation', enabled: false, priority: 1 },
  'geo-hubs': { name: 'Geopolitical Hubs', enabled: false, priority: 2 },
  'tech-hubs': { name: 'Hot Tech Hubs', enabled: false, priority: 2 },
};

const FULL_MAP_LAYERS: MapLayers = {
  aircraftEmergencies: false,
  iranAttacks: IRAN_ATTACKS_ENABLED,
  gpsJamming: false,

  conflicts: true,
  bases: false,
  cables: false,
  pipelines: false,
  storageFacilities: false,
  fuelShortages: false,
  hotspots: true,
  ais: false,
  nuclear: false,
  sanctions: false,
  weather: true,
  economic: true,
  waterways: true,
  outages: false,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  minerals: false,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  reservoirLevels: false,
  no2Activity: false,
  // Tech layers (disabled in full variant)
  // Finance layers (disabled in full variant)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  renewableInstallations: false,
  tradeRoutes: false,
  ciiChoropleth: false,
  // Commodity layers (disabled in full variant)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  diseaseOutbreaks: false,
};

const FULL_MOBILE_MAP_LAYERS: MapLayers = {
  aircraftEmergencies: false,
  iranAttacks: IRAN_ATTACKS_ENABLED,
  gpsJamming: false,

  conflicts: true,
  bases: false,
  cables: false,
  pipelines: false,
  storageFacilities: false,
  fuelShortages: false,
  hotspots: true,
  ais: false,
  nuclear: false,
  sanctions: true,
  weather: true,
  economic: false,
  waterways: false,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  minerals: false,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  reservoirLevels: false,
  no2Activity: false,
  // Tech layers (disabled in full variant)
  // Finance layers (disabled in full variant)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  renewableInstallations: false,
  tradeRoutes: false,
  ciiChoropleth: false,
  // Commodity layers (disabled in full variant)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  diseaseOutbreaks: false,
};

// ============================================
// TECH VARIANT (Tech/AI/Startups)
// ============================================



// ============================================
// FINANCE VARIANT (Markets/Trading)
// ============================================
const FINANCE_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Global Markets Map', enabled: true, priority: 1 },
  'live-news': { name: 'Market Headlines', enabled: true, priority: 1 },
  insights: { name: 'AI Market Insights', enabled: true, priority: 1 },
  markets: { name: 'Live Markets', enabled: true, priority: 1 },
  'daily-market-brief': { name: 'Daily Market Brief', enabled: true, priority: 1 },
  'markets-news': { name: 'Markets News', enabled: true, priority: 2 },
  forex: { name: 'Forex & Currencies', enabled: true, priority: 1 },
  fx: { name: 'FX Rates', enabled: false, priority: 2 },
  bonds: { name: 'Fixed Income', enabled: true, priority: 1 },
  commodities: { name: 'Metals & Materials', enabled: true, priority: 1 },
  'energy-complex': { name: 'Energy Complex', enabled: true, priority: 1 },
  // Required for finance variant's pipeline-click path. FINANCE_MAP_LAYERS
  // has `pipelines: true`, and PR #3366 unified all variants on
  // createEnergyPipelinesLayer which dispatches energy:open-pipeline-detail
  // on click. The listener lives in PipelineStatusPanel — if the key is
  // absent from this panel set, panel-layout never instantiates it and
  // the click is a silent no-op. Default disabled so the panel slot
  // doesn't auto-open; users invoke it by clicking a pipeline on the map
  // (or via CMD+K). Codex P1.
  'pipeline-status': { name: 'Oil & Gas Pipeline Status', enabled: false, priority: 2 },
  'commodities-news': { name: 'Commodities News', enabled: true, priority: 2 },
  centralbanks: { name: 'Central Bank Watch', enabled: true, priority: 1 },
  economic: { name: 'Macro Stress', enabled: true, priority: 1 },
  'global-procurement': { name: 'Global Procurement', enabled: true, priority: 1 },
  'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1 },
  'sanctions-pressure': { name: 'Sanctions Pressure', enabled: true, priority: 1 },
  'supply-chain': { name: 'Supply Chain', enabled: true, priority: 1 },
  'china-corridors': { name: 'China Logistics Corridors', enabled: false, priority: 2 },
  'china-activity-nowcast': { name: 'China Activity Nowcast', enabled: false, priority: 2 },
  'economic-news': { name: 'Economic News', enabled: true, priority: 2 },
  heatmap: { name: 'Sector Heatmap', enabled: true, priority: 1 },
  'macro-signals': { name: 'Market Regime', enabled: true, priority: 1 },
  'macro-tiles': { name: 'Macro Indicators', enabled: true, priority: 1 },
  'fear-greed': { name: 'Fear & Greed', enabled: true, priority: 1 },
  'market-breadth': { name: 'Market Breadth', enabled: true, priority: 1 },
  'news-market-correlation': { name: 'News ↔ Markets', enabled: true, priority: 1 },
  'fsi': { name: 'Financial Stress', enabled: true, priority: 1 },
  'yield-curve': { name: 'Yield Curve', enabled: true, priority: 1 },
  'economic-calendar': { name: 'Economic Calendar', enabled: true, priority: 1 },
  'cot-positioning': { name: 'COT Positioning', enabled: true, priority: 2 },
  'liquidity-shifts': { name: 'Liquidity Shifts', enabled: true, priority: 1 },
  'positioning-247': { name: '24/7 Positioning', enabled: true, priority: 1 },
  'gold-intelligence': { name: 'Gold Intelligence', enabled: true, priority: 60 },
  derivatives: { name: 'Derivatives & Options', enabled: true, priority: 2 },
  fintech: { name: 'Fintech & Trading Tech', enabled: true, priority: 2 },
  'fin-regulation': { name: 'Financial Regulation', enabled: true, priority: 2 },
  institutional: { name: 'Hedge Funds & PE', enabled: true, priority: 2 },
  analysis: { name: 'Market Analysis', enabled: true, priority: 2 },
  'gcc-investments': { name: 'GCC Investments', enabled: true, priority: 2 },
  gccNews: { name: 'GCC Business News', enabled: true, priority: 2 },
  'gulf-economies': { name: 'Gulf Economies', enabled: true, priority: 1 },
  'consumer-prices': { name: 'Consumer Prices', enabled: true, priority: 1 },
  polymarket: { name: 'Predictions', enabled: true, priority: 2 },
  'airline-intel': { name: 'Airline Intelligence', enabled: true, priority: 2 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
  'latest-brief': { name: 'Latest Brief', enabled: true, priority: 1 },
};

const FINANCE_MAP_LAYERS: MapLayers = {
  gpsJamming: false,

  conflicts: false,
  bases: false,
  cables: true,
  pipelines: true,
  hotspots: false,
  ais: false,
  nuclear: false,
  sanctions: true,
  weather: true,
  economic: true,
  waterways: true,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  minerals: false,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Tech layers (disabled in finance variant)
  // Finance layers (enabled in finance variant)
  stockExchanges: true,
  financialCenters: true,
  centralBanks: true,
  commodityHubs: false,
  gulfInvestments: false,
  renewableInstallations: false,
  tradeRoutes: true,
  iranAttacks: false,
  ciiChoropleth: false,
  // Commodity layers (disabled in finance variant)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  diseaseOutbreaks: false,
};

const FINANCE_MOBILE_MAP_LAYERS: MapLayers = {
  gpsJamming: false,

  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  sanctions: false,
  weather: false,
  economic: true,
  waterways: false,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  minerals: false,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Tech layers (disabled)
  // Finance layers (limited on mobile)
  stockExchanges: true,
  financialCenters: false,
  centralBanks: true,
  commodityHubs: false,
  gulfInvestments: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: false,
  ciiChoropleth: false,
  // Commodity layers (disabled in finance variant)
  miningSites: false,
  processingPlants: false,
  commodityPorts: false,
  diseaseOutbreaks: false,
};

// ============================================
// HAPPY VARIANT (Good News & Progress)
// ============================================


// ============================================
// COMMODITY VARIANT (Mining, Metals, Energy)
// ============================================
const COMMODITY_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Commodity Map', enabled: true, priority: 1 },
  'live-news': { name: 'Commodity Headlines', enabled: true, priority: 1 },
  insights: { name: 'AI Commodity Insights', enabled: true, priority: 1 },
  'commodity-news': { name: 'Commodity News', enabled: true, priority: 1 },
  'liquidity-shifts': { name: 'Liquidity Shifts', enabled: true, priority: 1 },
  'news-market-correlation': { name: 'News ↔ Markets', enabled: true, priority: 1 },
  'positioning-247': { name: '24/7 Positioning', enabled: true, priority: 1 },
  'gold-silver': { name: 'Gold & Silver', enabled: true, priority: 1 },
  energy: { name: 'Energy Markets', enabled: true, priority: 1 },
  'mining-news': { name: 'Mining News', enabled: true, priority: 1 },
  'critical-minerals': { name: 'Critical Minerals', enabled: true, priority: 1 },
  'base-metals': { name: 'Base Metals', enabled: true, priority: 1 },
  'mining-companies': { name: 'Mining Companies', enabled: true, priority: 1 },
  'supply-chain': { name: 'Supply Chain & Logistics', enabled: true, priority: 1 },
  'china-corridors': { name: 'China Logistics Corridors', enabled: false, priority: 2 },
  'china-activity-nowcast': { name: 'China Activity Nowcast', enabled: false, priority: 2 },
  'commodity-regulation': { name: 'Regulation & Policy', enabled: true, priority: 1 },
  markets: { name: 'Commodity Markets', enabled: true, priority: 1 },
  commodities: { name: 'Live Metals & Materials', enabled: true, priority: 1 },
  'energy-complex': { name: 'Energy Complex', enabled: true, priority: 1 },
  // Required for commodity variant's pipeline-click path — see FINANCE_PANELS
  // for the same rationale: `pipelines: true` + unified Redis-backed layer +
  // energy:open-pipeline-detail dispatch means the listener must be present
  // for the click to do anything. Codex P1.
  'pipeline-status': { name: 'Oil & Gas Pipeline Status', enabled: false, priority: 2 },
  'oil-inventories': { name: 'Oil Inventories', enabled: true, priority: 60 },
  'gold-intelligence': { name: 'Gold Intelligence', enabled: true, priority: 60 },
  heatmap: { name: 'Sector Heatmap', enabled: true, priority: 1 },
  'macro-signals': { name: 'Market Regime', enabled: true, priority: 1 },
  'trade-policy': { name: 'Trade Policy', enabled: true, priority: 1 },
  'sanctions-pressure': { name: 'Sanctions Pressure', enabled: true, priority: 1 },
  economic: { name: 'Macro Stress', enabled: true, priority: 1 },
  'gulf-economies': { name: 'Gulf & OPEC Economies', enabled: true, priority: 1 },
  'gcc-investments': { name: 'GCC Resource Investments', enabled: true, priority: 2 },
  'consumer-prices': { name: 'Consumer Prices', enabled: true, priority: 2 },
  'airline-intel': { name: 'Airline Intelligence', enabled: true, priority: 2 },
  polymarket: { name: 'Commodity Predictions', enabled: true, priority: 2 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 2 },
  monitors: { name: 'My Monitors', enabled: true, priority: 2 },
  'latest-brief': { name: 'Latest Brief', enabled: true, priority: 1 },
};

const COMMODITY_MAP_LAYERS: MapLayers = {
  gpsJamming: false,

  conflicts: false,
  bases: false,
  cables: false,
  pipelines: true,
  hotspots: false,
  ais: true,
  nuclear: false,
  sanctions: true,
  weather: true,
  economic: true,
  waterways: true,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  minerals: true,
  fires: true,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: true, // Climate events disrupt supply chains
  // Tech layers (disabled)
  // Finance layers (enabled for commodity hubs)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: true,
  gulfInvestments: false,
  renewableInstallations: false,
  tradeRoutes: true,
  iranAttacks: false,
  ciiChoropleth: false,
  // Commodity layers (enabled)
  miningSites: true,
  processingPlants: true,
  commodityPorts: true,
  diseaseOutbreaks: false,
};

const COMMODITY_MOBILE_MAP_LAYERS: MapLayers = {
  gpsJamming: false,

  conflicts: false,
  bases: false,
  cables: false,
  pipelines: false,
  hotspots: false,
  ais: false,
  nuclear: false,
  sanctions: false,
  weather: false,
  economic: true,
  waterways: false,
  outages: true,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  minerals: true,
  fires: false,
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: false,
  // Tech layers (disabled)
  // Finance layers (limited on mobile)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: true,
  gulfInvestments: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: false,
  ciiChoropleth: false,
  // Commodity layers (limited on mobile)
  miningSites: true,
  processingPlants: false,
  commodityPorts: true,
  diseaseOutbreaks: false,
};

// ============================================
// ENERGY variant — energy.worldmonitor.app
// Pipelines, storage, chokepoints, fuel shortages, disruption timeline.
// See docs/internal/global-energy-flow-parity-and-surpass.md (not committed).
// ============================================
const ENERGY_PANELS: Record<string, PanelConfig> = {
  map: { name: 'Energy Atlas Map', enabled: true, priority: 1 },
  'energy-risk-overview': { name: 'Global Energy Risk Overview', enabled: true, priority: 1 },
  'chokepoint-strip': { name: 'Chokepoint Status', enabled: true, priority: 1 },
  'pipeline-status': { name: 'Oil & Gas Pipeline Status', enabled: true, priority: 1 },
  'storage-facility-map': { name: 'Strategic Storage Atlas', enabled: true, priority: 1 },
  'fuel-shortages': { name: 'Global Fuel Shortage Registry', enabled: true, priority: 1 },
  'energy-disruptions': { name: 'Energy Disruptions Log', enabled: true, priority: 1 },
  'live-news': { name: 'Energy Headlines', enabled: true, priority: 1 },
  insights: { name: 'AI Energy Insights', enabled: true, priority: 1 },
  // Energy complex — existing panels reused at launch
  'energy-complex': { name: 'Oil & Gas Complex', enabled: true, priority: 1 },
  'oil-inventories': { name: 'Oil & Gas Inventories', enabled: true, priority: 1 },
  'hormuz-tracker': { name: 'Strait of Hormuz Tracker', enabled: true, priority: 1 },
  'energy-crisis': { name: 'Energy Crisis Policy Tracker', enabled: true, priority: 1 },
  'fuel-prices': { name: 'Retail Fuel Prices', enabled: true, priority: 1 },
  renewable: { name: 'Renewable Energy', enabled: true, priority: 2 },
  // Markets relevant to energy
  commodities: { name: 'Energy Commodities (WTI, Brent, NatGas)', enabled: true, priority: 1 },
  energy: { name: 'Energy Markets News', enabled: true, priority: 1 },
  'macro-signals': { name: 'Market Regime', enabled: true, priority: 2 },
  // Supply-chain & chokepoint context
  'supply-chain': { name: 'Chokepoints & Routes', enabled: true, priority: 1 },
  'china-corridors': { name: 'China Logistics Corridors', enabled: false, priority: 2 },
  'china-activity-nowcast': { name: 'China Activity Nowcast', enabled: false, priority: 2 },
  'sanctions-pressure': { name: 'Sanctions Pressure', enabled: true, priority: 2 },
  // Gulf / OPEC
  'gulf-economies': { name: 'Gulf & OPEC Economies', enabled: true, priority: 2 },
  'gcc-investments': { name: 'GCC Energy Investments', enabled: true, priority: 2 },
  // Climate — demand driver (HDD / CDD future use)
  climate: { name: 'Climate & Weather Impact', enabled: true, priority: 2 },
  // Hydropower reservoirs and transboundary water (ICESat-2 levels)
  'reservoir-levels': { name: 'Strategic Water Levels', enabled: true, priority: 2 },
  // Tracking
  monitors: { name: 'My Monitors', enabled: true, priority: 3 },
  'world-clock': { name: 'World Clock', enabled: true, priority: 3 },
  'latest-brief': { name: 'Latest Brief', enabled: true, priority: 1 },
};

const ENERGY_MAP_LAYERS: MapLayers = {
  gpsJamming: false,
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: true, // First-class energy asset (Week 2 registry lands here)
  hotspots: false,
  ais: true, // Tanker positions at chokepoints
  nuclear: false,
  sanctions: true, // Energy sanctions flows
  weather: true,
  economic: false,
  waterways: true, // Strategic chokepoints (Hormuz, Suez, Bab el-Mandeb, etc.)
  outages: true, // Power / energy system status
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true, // Earthquakes near energy infrastructure
  minerals: true, // Critical-minerals + energy-transition overlap
  fires: true, // Fires near energy infrastructure / oilfields
  // Data source layers
  ucdpEvents: false,
  displacement: false,
  climate: true,
  // Tech layers (disabled)
  // Finance layers (energy hubs = commodity hubs for our purposes)
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: true,
  gulfInvestments: false,
  renewableInstallations: false,
  tradeRoutes: true,
  iranAttacks: false,
  ciiChoropleth: false,
  // Commodity layers — selected (energy-relevant subset)
  miningSites: false,
  processingPlants: false,
  commodityPorts: true, // LNG import/export + crude terminals
  diseaseOutbreaks: false,
  storageFacilities: true, // UGS / SPR / LNG / crude hubs (Day 9-10 registry)
  fuelShortages: true, // Global fuel shortage alerts (Day 11-12 registry)
  liveTankers: true, // AIS ship type 80-89 inside chokepoint bboxes (parity-push PR 3)
  reservoirLevels: false,
};

const ENERGY_MOBILE_MAP_LAYERS: MapLayers = {
  gpsJamming: false,
  conflicts: false,
  bases: false,
  cables: false,
  pipelines: true,
  hotspots: false,
  ais: false,
  nuclear: false,
  sanctions: false,
  weather: false,
  economic: false,
  waterways: true,
  outages: false,
  cyberThreats: false,
  datacenters: false,
  protests: false,
  flights: false,
  military: false,
  natural: true,
  minerals: false,
  fires: false,
  ucdpEvents: false,
  displacement: false,
  climate: false,
  stockExchanges: false,
  financialCenters: false,
  centralBanks: false,
  commodityHubs: false,
  gulfInvestments: false,
  renewableInstallations: false,
  tradeRoutes: false,
  iranAttacks: false,
  ciiChoropleth: false,
  miningSites: false,
  processingPlants: false,
  commodityPorts: true,
  diseaseOutbreaks: false,
  storageFacilities: true,
  fuelShortages: true,
  liveTankers: true,
  reservoirLevels: false,
};

// ============================================
// UNIFIED PANEL REGISTRY
// ============================================

type PanelVariant = 'full' | 'finance' | 'commodity' | 'energy';

const VARIANT_PANEL_CONFIGS: Record<PanelVariant, Record<string, PanelConfig>> = {
  full: FULL_PANELS,
  finance: FINANCE_PANELS,
  commodity: COMMODITY_PANELS,
  energy: ENERGY_PANELS,
};

function getVariantPanelConfigs(variant: string): Record<string, PanelConfig> | undefined {
  return Object.prototype.hasOwnProperty.call(VARIANT_PANEL_CONFIGS, variant)
    ? VARIANT_PANEL_CONFIGS[variant as PanelVariant]
    : undefined;
}

/** True when `panelId` is in the selected monitor's native catalog, not merely in ALL_PANELS. */
export function isPanelNativeToVariant(panelId: string, variant: string): boolean {
  const configs = getVariantPanelConfigs(variant);
  return Boolean(configs && Object.prototype.hasOwnProperty.call(configs, panelId));
}

export const RETIRED_PANEL_IDS: ReadonlySet<string> = new Set([
  'grid-disruption-clock',
  'nq-pulse',
  'nq-catalysts',
  'nq-news',
  'stock-analysis',
  'stock-backtest',
  'aaii-sentiment',
  'earnings-calendar',
  'ipo',
  'material-events',
  'crypto',
  'etf-flows',
  'stablecoins',
  'crypto-news',
  'crypto-heatmap',
  'defi-tokens',
  'ai-tokens',
  'other-tokens',
  'startups',
  'vcblogs',
  'regionalStartups',
  'unicorns',
  'accelerators',
  'security',
  'policy',
  'hardware',
  'cloud',
  'dev',
  'github',
  'funding',
  'producthunt',
  'events',
  'ai-regulation',
  'positive-feed',
  'progress',
  'counters',
  'spotlight',
  'breakthroughs',
  'digest',
  'species',
  'giving',
  'toronto-safety',
  'live-webcams',
  'windy-webcams',
  'live-youtube',
  'pinned-webcams',
]);

export function isRetiredPanel(panelId: string): boolean {
  return RETIRED_PANEL_IDS.has(panelId);
}

/** All panels from all variants — canonical cross-variant registry. */
export const ALL_PANELS: Record<string, PanelConfig> = {
  ...COMMODITY_PANELS,
  ...ENERGY_PANELS,
  ...FINANCE_PANELS,
  ...FULL_PANELS,
};

/** Per-variant canonical panel order (keys = which panels are enabled by default). */
export const VARIANT_DEFAULTS: Record<string, string[]> = {
  full:      Object.keys(VARIANT_PANEL_CONFIGS.full),
  finance:   Object.keys(VARIANT_PANEL_CONFIGS.finance),
  commodity: Object.keys(VARIANT_PANEL_CONFIGS.commodity),
  energy:    Object.keys(VARIANT_PANEL_CONFIGS.energy),
};

/**
 * Variant-specific label overrides for panels shared across variants.
 * Applied at render time, not just at seed time. Each `name` is translated
 * as `panelVariants.<variant>.<camelCaseKey>` in src/locales.
 */
export const VARIANT_PANEL_OVERRIDES: Partial<Record<string, Partial<Record<string, Partial<PanelConfig>>>>> = {
  finance: {
    map:         { name: 'Global Markets Map' },
    'live-news': { name: 'Market Headlines' },
    insights:    { name: 'AI Market Insights' },
  },
  commodity: {
    map:         { name: 'Commodity Map' },
    'live-news': { name: 'Commodity Headlines' },
    insights:    { name: 'AI Commodity Insights' },
  },
  energy: {
    map:         { name: 'Energy Atlas Map' },
    'live-news': { name: 'Energy Headlines' },
    insights:    { name: 'AI Energy Insights' },
  },
};

/**
 * Returns the effective panel config for a given key and variant,
 * applying variant-specific display overrides (name, etc.).
 */
export function getEffectivePanelConfig(key: string, variant: string): PanelConfig {
  const base = getVariantPanelConfigs(variant)?.[key] ?? ALL_PANELS[key];
  if (!base) return { name: key, enabled: false, priority: 2 };
  const override = VARIANT_PANEL_OVERRIDES[variant]?.[key] ?? {};
  return { ...base, ...override };
}

/**
 * Build the same canonical panel-settings seed App uses on a first visit:
 * every panel is addressable, while only the selected variant's enabled
 * defaults are active. Keeping this pure also gives non-DOM integrations a
 * variant-realistic state without duplicating App's merge formula.
 */
export function getInitialPanelSettingsForVariant(variant: string): Record<string, PanelConfig> {
  const variantDefaults = new Set(VARIANT_DEFAULTS[variant] ?? VARIANT_DEFAULTS.full ?? []);
  return Object.fromEntries(
    Object.keys(ALL_PANELS).map((key) => {
      const config = getEffectivePanelConfig(key, variant);
      return [key, { ...config, enabled: variantDefaults.has(key) && config.enabled }];
    }),
  );
}

/**
 * Returns true if `key` is in the current variant's default panel set.
 *
 * App.ts:577-583 merges ALL_PANELS into panelSettings on every variant so
 * users can cross-enable panels, which makes `shouldCreatePanel(key)`
 * (which just checks `key in panelSettings`) true everywhere. Auto-refresh
 * paths that fan out a fetch must instead gate on the variant defaults —
 * otherwise variants whose backend doesn't seed the panel's bootstrap key
 * (e.g. tech-readiness on commodity/finance/energy) blow their 5s fetch
 * budget on a key that will never populate.
 */
const SITE_VARIANT_DEFAULTS = new Set(VARIANT_DEFAULTS[SITE_VARIANT] ?? []);

export function isPanelInVariantDefaults(key: string): boolean {
  return SITE_VARIANT_DEFAULTS.has(key);
}

/**
 * Apply a USER-initiated enable/disable to a panel config.
 *
 * Every user toggle path must go through this. Once the user takes a position
 * on a panel, a leftover `proGated` marker must go, or the next
 * `restoreProGatedPanels` would resurrect a panel the user chose to hide.
 *
 * Mutates in place: every call site already owns a live entry in the
 * panelSettings map it is about to persist.
 */
export function userSetPanelEnabled(config: PanelConfig, enabled: boolean): void {
  config.enabled = enabled;
  delete config.proGated;
}

/**
 * Re-enable panels an earlier free-tier clamp hid (custom widgets or the old
 * panel-count cap) and clear the marker. Only panels carrying `proGated` are
 * touched, so a panel the user hid deliberately via settings stays hidden.
 */
export function restoreProGatedPanels(
  panelSettings: Record<string, PanelConfig>,
): Record<string, PanelConfig> {
  const next: Record<string, PanelConfig> = {};
  for (const [key, config] of Object.entries(panelSettings)) {
    if (config.proGated) {
      const { proGated: _proGated, ...rest } = config;
      next[key] = { ...rest, enabled: true };
    } else {
      next[key] = { ...config };
    }
  }
  return next;
}

// ============================================
// VARIANT-AWARE EXPORTS
// ============================================
export const DEFAULT_PANELS: Record<string, PanelConfig> = Object.fromEntries(
  (VARIANT_DEFAULTS[SITE_VARIANT] ?? VARIANT_DEFAULTS['full'] ?? []).map(key =>
    [key, getEffectivePanelConfig(key, SITE_VARIANT)]
  )
);

export const DEFAULT_MAP_LAYERS = SITE_VARIANT === 'finance'
      ? FINANCE_MAP_LAYERS
      : SITE_VARIANT === 'commodity'
        ? COMMODITY_MAP_LAYERS
        : SITE_VARIANT === 'energy'
          ? ENERGY_MAP_LAYERS
          : FULL_MAP_LAYERS;

export const MOBILE_DEFAULT_MAP_LAYERS = SITE_VARIANT === 'finance'
      ? FINANCE_MOBILE_MAP_LAYERS
      : SITE_VARIANT === 'commodity'
        ? COMMODITY_MOBILE_MAP_LAYERS
        : SITE_VARIANT === 'energy'
          ? ENERGY_MOBILE_MAP_LAYERS
          : FULL_MOBILE_MAP_LAYERS;

/** Maps map-layer toggle keys to their data-freshness source IDs (single source of truth). */
export const LAYER_TO_SOURCE: Partial<Record<keyof MapLayers, DataSourceId[]>> = {
  military: ['opensky', 'wingbits'],
  ais: ['ais'],
  natural: ['usgs'],
  weather: ['weather'],
  outages: ['outages'],
  cyberThreats: ['cyber_threats'],
  protests: ['acled', 'gdelt_doc'],
  ucdpEvents: ['ucdp_events'],
  displacement: ['unhcr'],
  climate: ['climate'],
  sanctions: ['sanctions_pressure'],
};

// ============================================
// PANEL CATEGORY MAP
// ============================================
// Maps category keys to panel keys. Only categories with at least one
// matching panel in the user's active panel settings are shown.
export const PANEL_CATEGORY_MAP: Record<string, { labelKey: string; panelKeys: string[]; variants?: string[] }> = {
  // All variants — essential panels
  core: {
    labelKey: 'header.panelCatCore',
    panelKeys: ['map', 'live-news', 'insights', 'strategic-posture', 'latest-brief'],
  },

  // Full (geopolitical) variant — marketsFinance/topical/dataTracking are
  // shared with the energy variant, which has no dedicated category block.
  intelligence: {
    labelKey: 'header.panelCatIntelligence',
    panelKeys: ['cii', 'strategic-risk', 'threat-timeline', 'intel', 'gdelt-intel', 'cascade', 'forecast', 'cross-source-signals', 'regional-intelligence', 'deduction', 'chat-analyst', 'thermal-escalation', 'geo-hubs'],
    variants: ['full'],
  },
  correlation: {
    labelKey: 'header.panelCatCorrelation',
    panelKeys: ['military-correlation', 'escalation-correlation', 'economic-correlation', 'disaster-correlation'],
    variants: ['full'],
  },
  regionalNews: {
    labelKey: 'header.panelCatRegionalNews',
    panelKeys: ['politics', 'us', 'europe', 'middleeast', 'africa', 'latam', 'asia'],
    variants: ['full'],
  },
  marketsFinance: {
    labelKey: 'header.panelCatMarketsFinance',
    panelKeys: ['commodities', 'energy-complex', 'energy-risk-overview', 'pipeline-status', 'storage-facility-map', 'renewable', 'oil-inventories', 'fuel-prices', 'chokepoint-strip', 'fuel-shortages', 'energy-disruptions', 'hormuz-tracker', 'energy-crisis', 'markets', 'daily-market-brief', 'economic', 'global-procurement', 'trade-policy', 'sanctions-pressure', 'supply-chain', 'china-corridors', 'china-activity-nowcast', 'finance', 'polymarket', 'macro-signals', 'gulf-economies', 'consumer-prices', 'heatmap', 'cot-positioning', 'economic-calendar', 'fear-greed', 'fsi', 'macro-tiles', 'market-breadth', 'news-market-correlation', 'liquidity-shifts', 'national-debt', 'positioning-247', 'yield-curve', 'gold-intelligence', 'fx', 'market-implications'],
    variants: ['full', 'energy'],
  },
  topical: {
    labelKey: 'header.panelCatTopical',
    panelKeys: ['energy', 'gov', 'thinktanks', 'tech', 'ai', 'layoffs', 'science', 'tech-hubs'],
    variants: ['full', 'energy'],
  },
  dataTracking: {
    labelKey: 'header.panelCatDataTracking',
    panelKeys: ['monitors', 'ukmto-incidents', 'satellite-fires', 'ucdp-events', 'displacement', 'climate', 'reservoir-levels', 'climate-news', 'population-exposure', 'security-advisories', 'service-status', 'internet-disruptions', 'radiation-watch', 'oref-sirens', 'airline-intel', 'world-clock', 'tech-readiness', 'disease-outbreaks', 'fao-food-price-index', 'grocery-basket'],
    variants: ['full', 'energy'],
  },

  // Finance variant
  finMarkets: {
    labelKey: 'header.panelCatMarkets',
    panelKeys: ['fintech', 'markets', 'daily-market-brief', 'markets-news', 'heatmap', 'macro-signals', 'analysis', 'polymarket'],
    variants: ['finance'],
  },
  fixedIncomeFx: {
    labelKey: 'header.panelCatFixedIncomeFx',
    panelKeys: ['forex', 'fx', 'bonds'],
    variants: ['finance'],
  },
  finCommodities: {
    labelKey: 'header.panelCatCommodities',
    panelKeys: ['commodities', 'energy-complex', 'commodities-news'],
    variants: ['finance'],
  },
  centralBanksEcon: {
    labelKey: 'header.panelCatCentralBanks',
    panelKeys: ['centralbanks', 'economic', 'global-procurement', 'energy-complex', 'trade-policy', 'sanctions-pressure', 'supply-chain', 'china-corridors', 'china-activity-nowcast', 'economic-news'],
    variants: ['finance'],
  },
  dealsInstitutional: {
    labelKey: 'header.panelCatDeals',
    panelKeys: ['derivatives', 'institutional', 'fin-regulation'],
    variants: ['finance'],
  },
  gulfMena: {
    labelKey: 'header.panelCatGulfMena',
    panelKeys: ['gulf-economies', 'gcc-investments', 'gccNews', 'consumer-prices', 'monitors', 'world-clock'],
    variants: ['finance'],
  },

  // Commodity variant
  commodityPrices: {
    labelKey: 'header.panelCatCommodityPrices',
    panelKeys: ['commodities', 'energy-complex', 'gold-silver', 'energy', 'base-metals', 'critical-minerals', 'markets', 'heatmap', 'macro-signals'],
    variants: ['commodity'],
  },
  miningIndustry: {
    labelKey: 'header.panelCatMining',
    panelKeys: ['commodity-news', 'mining-news', 'mining-companies', 'supply-chain', 'china-corridors', 'china-activity-nowcast', 'commodity-regulation'],
    variants: ['commodity'],
  },
  commodityEcon: {
    labelKey: 'header.panelCatCommodityEcon',
    panelKeys: ['trade-policy', 'sanctions-pressure', 'economic', 'gulf-economies', 'gcc-investments', 'consumer-prices', 'finance', 'polymarket', 'airline-intel', 'world-clock', 'monitors'],
    variants: ['commodity'],
  },

};

export interface VariantPanelCategory {
  key: string;
  labelKey: string;
  panelKeys: string[];
}

// Categories applicable to `variant` that contain at least one enabled panel.
// Shared by the settings panel-tab filter and the mobile category nav —
// callers prepend their own "all" entry and localize labelKey via t().
export function getVariantPanelCategories(
  panelSettings: Record<string, PanelConfig>,
  variant: string,
): VariantPanelCategory[] {
  return Object.entries(PANEL_CATEGORY_MAP)
    .filter(([, def]) => !def.variants || def.variants.includes(variant))
    .filter(([, def]) => def.panelKeys.some((pk) => panelSettings[pk]?.enabled))
    .map(([key, def]) => ({ key, labelKey: def.labelKey, panelKeys: def.panelKeys }));
}
