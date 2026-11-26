import type { MapLayers } from '@/types';

/**
 * The two concrete map renderers a layer can be painted by. This is the
 * single renderer axis: `'svg'` (D3/SVG mobile fallback in Map.ts) and
 * `'deck'` (WebGL DeckGLMap). It mirrors MapContainer's `RendererKind`
 * (computed by `getPendingRendererKind()`), which imports this type so the
 * picker, dispatcher, and shell stay in lockstep.
 */
export type RendererKind = 'svg' | 'deck';
export type MapVariant = 'full' | 'tech' | 'finance' | 'happy' | 'commodity' | 'energy';


export interface LayerDefinition {
  key: keyof MapLayers;
  icon: string;
  i18nSuffix: string;
  fallbackLabel: string;
  /**
   * Every renderer that has a real paint path for this layer. A layer executes
   * (picker toggle / CMD+K dispatch) under a renderer only if that renderer is
   * listed here — this is the whole gate. A DeckGL-only layer is `['deck']`; a
   * layer on both surfaces is `['svg', 'deck']`.
   */
  renderers: RendererKind[];
}

export type LayerExplanationCoverage = 'curated' | 'fallback';

export interface LayerExplanation {
  key: keyof MapLayers;
  coverage: LayerExplanationCoverage;
  evidence: string[];
}

export function layerExplanationCopyPrefix(layerKey: keyof MapLayers, coverage: LayerExplanationCoverage): string {
  return coverage === 'curated'
    ? `layerExplanation.layers.${layerKey}`
    : 'layerExplanation.fallback';
}

const def = (
  key: keyof MapLayers,
  icon: string,
  i18nSuffix: string,
  fallbackLabel: string,
  renderers: RendererKind[] = ['svg', 'deck'],
): LayerDefinition => ({
  key, icon, i18nSuffix, fallbackLabel, renderers,
});

export const LAYER_REGISTRY: Record<keyof MapLayers, LayerDefinition> = {
  iranAttacks:              def('iranAttacks',              '&#127919;', 'iranAttacks',              'Middle East Strikes', ['svg', 'deck']),
  hotspots:                 def('hotspots',                 '&#127919;', 'intelHotspots',            'Intel Hotspots'),
  conflicts:                def('conflicts',                '&#9876;',   'conflictZones',            'Conflict Zones'),

  bases:                    def('bases',                    '&#127963;', 'militaryBases',            'Military Bases'),
  nuclear:                  def('nuclear',                  '&#9762;',   'nuclearSites',             'Nuclear Sites'),

  cables:                   def('cables',                   '&#128268;', 'underseaCables',           'Undersea Cables'),
  pipelines:                def('pipelines',                '&#128738;', 'pipelines',                'Pipelines'),
  datacenters:              def('datacenters',              '&#128421;', 'aiDataCenters',            'AI Data Centers'),
  military:                 def('military',                 '&#9992;',   'militaryActivity',         'Military Activity'),
  aircraftEmergencies:       def('aircraftEmergencies',       '&#9888;',   'aircraftEmergencies',      'Aircraft Emergencies', ['svg', 'deck']),
  ais:                      def('ais',                      '&#128674;', 'shipTraffic',              'Ship Traffic'),
  tradeRoutes:              def('tradeRoutes',              '&#9875;',   'tradeRoutes',              'Trade Routes'),
  flights:                  def('flights',                  '&#9992;',   'flightDelays',             'Aviation'),
  protests:                 def('protests',                 '&#128226;', 'protests',                 'Protests'),
  ucdpEvents:               def('ucdpEvents',               '&#9876;',   'ucdpEvents',               'Armed Conflict Events'),
  displacement:             def('displacement',             '&#128101;', 'displacementFlows',        'Displacement Flows'),
  climate:                  def('climate',                  '&#127787;', 'climateAnomalies',         'Climate Anomalies'),
  weather:                  def('weather',                  '&#9928;',   'weatherAlerts',            'Weather Alerts'),
  outages:                  def('outages',                  '&#128225;', 'internetOutages',          'Internet Disruptions'),
  cyberThreats:             def('cyberThreats',             '&#128737;', 'cyberThreats',             'Cyber Threats'),
  natural:                  def('natural',                  '&#127755;', 'naturalEvents',            'Natural Events'),
  fires:                    def('fires',                    '&#128293;', 'fires',                    'Fires'),
  waterways:                def('waterways',                '&#9875;',   'strategicWaterways',       'Chokepoints'),
  economic:                 def('economic',                 '&#128176;', 'economicCenters',          'Economic Centers'),
  minerals:                 def('minerals',                 '&#128142;', 'criticalMinerals',         'Critical Minerals'),
  gpsJamming:               def('gpsJamming',               '&#128225;', 'gpsJamming',               'GPS Jamming', ['svg', 'deck']),
  // Only DeckGLMap builds the CII choropleth polygons; the SVG/mobile
  // fallback has no CII paint path.
  ciiChoropleth:            def('ciiChoropleth',            '&#127758;', 'ciiChoropleth',            'Country Instability', ['deck']),
  sanctions:                def('sanctions',                '&#128683;', 'sanctions',                'Sanctions', ['svg', 'deck']),
  no2Activity:              def('no2Activity',              '&#127981;', 'no2Activity',              'Industrial Activity', ['deck']),
  reservoirLevels:          def('reservoirLevels',          '&#128167;', 'reservoirLevels',          'Water Levels'),
  startupHubs:              def('startupHubs',              '&#128640;', 'startupHubs',              'Startup Hubs', ['svg', 'deck']),
  techHQs:                  def('techHQs',                  '&#127970;', 'techHQs',                  'Tech HQs', ['svg', 'deck']),
  accelerators:             def('accelerators',             '&#9889;',   'accelerators',             'Accelerators', ['svg', 'deck']),
  cloudRegions:             def('cloudRegions',             '&#9729;',   'cloudRegions',             'Cloud Regions', ['svg', 'deck']),
  techEvents:               def('techEvents',               '&#128197;', 'techEvents',               'Tech Events'),
  stockExchanges:           def('stockExchanges',           '&#127963;', 'stockExchanges',           'Stock Exchanges', ['svg', 'deck']),
  financialCenters:         def('financialCenters',         '&#128176;', 'financialCenters',         'Financial Centers', ['svg', 'deck']),
  centralBanks:             def('centralBanks',             '&#127974;', 'centralBanks',             'Central Banks', ['svg', 'deck']),
  commodityHubs:            def('commodityHubs',            '&#128230;', 'commodityHubs',            'Commodity Hubs', ['svg', 'deck']),
  gulfInvestments:          def('gulfInvestments',          '&#127760;', 'gulfInvestments',          'GCC Investments', ['deck']),
  positiveEvents:           def('positiveEvents',           '&#127775;', 'positiveEvents',           'Positive Events', ['deck']),
  kindness:                 def('kindness',                 '&#128154;', 'kindness',                 'Acts of Kindness', ['deck']),
  happiness:                def('happiness',                '&#128522;', 'happiness',                'World Happiness', ['deck']),
  speciesRecovery:          def('speciesRecovery',          '&#128062;', 'speciesRecovery',          'Species Recovery', ['deck']),
  renewableInstallations:   def('renewableInstallations',   '&#9889;',   'renewableInstallations',   'Clean Energy', ['deck']),
  miningSites:              def('miningSites',              '&#128301;', 'miningSites',              'Mining Sites', ['deck']),
  processingPlants:         def('processingPlants',         '&#127981;', 'processingPlants',         'Processing Plants', ['deck']),
  commodityPorts:           def('commodityPorts',           '&#9973;',   'commodityPorts',           'Commodity Ports', ['deck']),
  webcams:                  def('webcams',                  '&#128247;', 'webcams',                  'Live Webcams'),
  // weatherRadar removed — radar tiles now auto-start when Weather Alerts layer is toggled on
  diseaseOutbreaks:         def('diseaseOutbreaks',         '&#129440;', 'diseaseOutbreaks',         'Disease Outbreaks', ['deck']),
  // DeckGL-only layers: `renderers: ['deck']` hides them from the SVG/mobile
  // fallback's CMD+K dispatch (Map.ts has no SVG render path for either
  // marker/pin type). Add 'svg' here once that renderer gains real support.
  storageFacilities:        def('storageFacilities',        '&#127959;', 'storageFacilities',        'Storage Facilities', ['deck']),
  fuelShortages:            def('fuelShortages',            '&#9881;',   'fuelShortages',            'Fuel Shortages', ['deck']),
  liveTankers:              def('liveTankers',              '&#128674;', 'liveTankers',              'Live Tanker Positions', ['deck']),
};

export const V1_LAYER_EXPLANATION_KEYS = [
  'conflicts',
  'ucdpEvents',
  'ciiChoropleth',
  'natural',
  'weather',
  'flights',
  'aircraftEmergencies',
  'ais',
  'waterways',
  'tradeRoutes',
  'cyberThreats',
  'hotspots',
  'no2Activity',
  'reservoirLevels',
] as const satisfies readonly (keyof MapLayers)[];

export const LAYER_EXPLANATIONS: Partial<Record<keyof MapLayers, LayerExplanation>> = {
  conflicts: { key: 'conflicts', coverage: 'curated', evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'src/config/geo.ts'] },
  ucdpEvents: { key: 'ucdpEvents', coverage: 'curated', evidence: ['docs/architecture.mdx', 'src/services/conflict/index.ts', 'scripts/seed-ucdp-events.mjs'] },
  ciiChoropleth: { key: 'ciiChoropleth', coverage: 'curated', evidence: ['docs/strategic-risk.mdx', 'docs/architecture.mdx', 'src/services/cached-risk-scores.ts'] },
  natural: { key: 'natural', coverage: 'curated', evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'server/worldmonitor/natural/v1/list-natural-events.ts'] },
  weather: { key: 'weather', coverage: 'curated', evidence: ['scripts/personal-providers.cjs', 'scripts/_weather-alert-select.mjs', 'api/health.js', 'src/services/weather.ts'] },
  flights: { key: 'flights', coverage: 'curated', evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'src/services/aviation/index.ts', 'scripts/seed-aviation.mjs', 'scripts/seed-notam-nms.mjs', 'src/services/notam-airspace.ts'] },
  aircraftEmergencies: { key: 'aircraftEmergencies', coverage: 'curated', evidence: ['docs/aircraft-emergencies-evidence.md'] },
  ais: { key: 'ais', coverage: 'curated', evidence: ['docs/features.mdx', 'docs/architecture.mdx', 'src/services/maritime/index.ts', 'scripts/personal-providers.cjs'] },
  waterways: { key: 'waterways', coverage: 'curated', evidence: ['docs/architecture.mdx', 'docs/data-sources.mdx', 'src/config/geo.ts', 'server/worldmonitor/supply-chain/v1/get-chokepoint-status.ts'] },
  tradeRoutes: { key: 'tradeRoutes', coverage: 'curated', evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'src/config/trade-routes.ts', 'src/services/supply-chain/index.ts'] },
  cyberThreats: { key: 'cyberThreats', coverage: 'curated', evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'scripts/seed-cyber-threats.mjs', 'server/worldmonitor/cyber/v1/list-cyber-threats.ts'] },
  hotspots: { key: 'hotspots', coverage: 'curated', evidence: ['docs/data-sources.mdx', 'docs/architecture.mdx', 'src/config/geo.ts', 'src/services/hotspot-escalation.ts'] },
  no2Activity: { key: 'no2Activity', coverage: 'curated', evidence: ['scripts/seed-no2-activity.mjs', 'scripts/shared/no2-activity.mjs', 'api/health.js', 'server/worldmonitor/economic/v1/get-no2-activity.ts'] },
  reservoirLevels: { key: 'reservoirLevels', coverage: 'curated', evidence: ['docs/data-sources.mdx', 'scripts/_reservoir-levels.mjs', 'scripts/seed-reservoir-levels.mjs', 'tests/reservoir-levels-validation.test.mjs', 'server/worldmonitor/climate/v1/list-reservoir-levels.ts'] },
};

const VARIANT_LAYER_ORDER: Record<MapVariant, Array<keyof MapLayers>> = {
  full: [
    'iranAttacks', 'hotspots', 'conflicts',
    'bases', 'nuclear',
    'cables', 'pipelines', 'storageFacilities', 'fuelShortages', 'datacenters', 'military',
    'ais', 'tradeRoutes', 'flights', 'aircraftEmergencies', 'protests',
    'ucdpEvents', 'displacement', 'climate', 'weather',
    'outages', 'cyberThreats', 'natural', 'fires',
    'waterways', 'economic', 'minerals', 'gpsJamming',
    'ciiChoropleth', 'sanctions', 'no2Activity', 'reservoirLevels', 'webcams',
    'diseaseOutbreaks',
  ],
  tech: [
    'startupHubs', 'techHQs', 'accelerators', 'cloudRegions',
    'datacenters', 'cables', 'outages', 'cyberThreats',
    'techEvents', 'natural', 'fires',
  ],
  finance: [
    'stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs',
    'gulfInvestments', 'tradeRoutes', 'cables', 'pipelines',
    'outages', 'weather', 'economic', 'waterways',
    'natural', 'cyberThreats', 'sanctions',
  ],
  happy: [
    'positiveEvents', 'kindness', 'happiness',
    'speciesRecovery', 'renewableInstallations',
  ],
  commodity: [
    'miningSites', 'processingPlants', 'commodityPorts', 'commodityHubs',
    'minerals', 'pipelines', 'waterways', 'tradeRoutes',
    'ais', 'economic', 'fires', 'climate',
    'natural', 'weather', 'outages', 'sanctions',
  ],
  energy: [
    // Core energy infrastructure — mirror of ENERGY_MAP_LAYERS in panels.ts
    'pipelines', 'storageFacilities', 'fuelShortages', 'waterways', 'commodityPorts', 'commodityHubs',
    'ais', 'liveTankers', 'tradeRoutes', 'minerals',
    // Energy-adjacent context
    'sanctions', 'fires', 'climate', 'reservoirLevels', 'weather', 'outages', 'natural',
  ],
};

const I18N_PREFIX = 'components.deckgl.layers.';

// Iran-events domain sunset (war ended 2026-07). Default OFF: hide the layer
// from the picker (getLayersForVariant), strip it from any restored MapLayers
// (getAllowedLayerKeys → sanitizeLayersForVariant), and make CMD+K skip it
// (isLayerExecutable). Set VITE_ENABLE_IRAN_ATTACKS=true (+ backend
// IRAN_EVENTS_ENABLED=true) and rebuild to restore. Mirrors CYBER_LAYER_ENABLED.
// Guarded with isClientRuntime so `import.meta.env` (undefined under node:test,
// where this config module is imported directly) is never dereferenced there —
// see src/services/maritime/index.ts and tests/browser-bundle-secret-guard.
const IRAN_ATTACKS_ENABLED = typeof window !== 'undefined' && import.meta.env.VITE_ENABLE_IRAN_ATTACKS === 'true';

/** True when a layer is feature-sunset and must not appear in any picker. */
export function isSunsetLayer(key: keyof MapLayers): boolean {
  return !IRAN_ATTACKS_ENABLED && key === 'iranAttacks';
}

export function getOrderedLayerKeys(variant: MapVariant): Array<keyof MapLayers> {
  return (VARIANT_LAYER_ORDER[variant] ?? VARIANT_LAYER_ORDER.full)
    .filter(k => !isSunsetLayer(k));
}

export function getCompleteLayerCatalogKeys(variant: MapVariant): Array<keyof MapLayers> {
  const primary = getOrderedLayerKeys(variant);
  const seen = new Set(primary);
  const rest = (Object.keys(LAYER_REGISTRY) as Array<keyof MapLayers>)
    .filter(k => !seen.has(k) && !isSunsetLayer(k));
  return [...primary, ...rest];
}

export function getLayersForVariant(variant: MapVariant, kind: RendererKind): LayerDefinition[] {
  return getOrderedLayerKeys(variant)
    .map(k => LAYER_REGISTRY[k])
    .filter(d => d.renderers.includes(kind));
}

export function getAllowedLayerKeys(variant: MapVariant): Set<keyof MapLayers> {
  return new Set(getOrderedLayerKeys(variant));
}

/**
 * Clamp a restored layer state to the variant. Keys that are no longer map
 * layers (saved state, URL deep links, presets or backups written before a
 * layer was removed) are dropped silently so they never reach a renderer.
 */
export function sanitizeLayersForVariant(layers: MapLayers, variant: MapVariant): MapLayers {
  const allowed = getAllowedLayerKeys(variant);
  const sanitized = { ...layers };
  for (const key of Object.keys(sanitized) as Array<keyof MapLayers>) {
    if (!Object.prototype.hasOwnProperty.call(LAYER_REGISTRY, key)) {
      delete sanitized[key];
    } else if (!allowed.has(key)) {
      sanitized[key] = false;
    }
  }
  return sanitized;
}

/**
 * Checks whether a layer can actually render under the active renderer. Used
 * by both the layer picker UI and the CMD+K dispatcher to hide / silently-skip
 * toggles that would be a no-op.
 *
 * The layer's declared `renderers` must include `kind`. Because the axis now
 * distinguishes `'svg'` from `'deck'`, a DeckGL-only layer (`['deck']`) is
 * naturally rejected on the SVG fallback — no separate flag.
 */
export function isLayerExecutable(
  layerKey: keyof MapLayers,
  kind: RendererKind,
): boolean {
  if (isSunsetLayer(layerKey)) return false;
  const def = LAYER_REGISTRY[layerKey];
  if (!def) return false;
  return def.renderers.includes(kind);
}

/**
 * Whether a CMD+K layer command may toggle the layer in the current map
 * context. The personal build has no layer entitlements, so this is the
 * renderer-compatibility check alone.
 */
export function isLayerCommandAllowed(
  layerKey: keyof MapLayers,
  kind: RendererKind,
): boolean {
  return isLayerExecutable(layerKey, kind);
}

export function mapLayerStatesEqual(a: MapLayers, b: MapLayers): boolean {
  const keys = Object.keys(a) as Array<keyof MapLayers>;
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/**
 * Layers the retired free-tier gate could force off (`premium: 'locked'`
 * before the personal build unlocked them: iranAttacks and gpsJamming on desktop). Ownership markers stored by that
 * gate name only these keys, so restoration is limited to them.
 */
const RETIRED_GATE_LOCKED_LAYERS: ReadonlySet<string> = new Set(['iranAttacks', 'gpsJamming']);

/** Restore only valid layers previously disabled by the retired free gate. */
export function restoreGateOwnedLockedLayers(
  layers: MapLayers,
  gateOwned: ReadonlySet<string>,
): MapLayers {
  let changed = false;
  const restored = { ...layers };
  for (const rawKey of gateOwned) {
    const key = rawKey as keyof MapLayers;
    if (!RETIRED_GATE_LOCKED_LAYERS.has(key) || !LAYER_REGISTRY[key] || restored[key] === true) continue;
    restored[key] = true;
    changed = true;
  }
  return changed ? restored : layers;
}

export const LAYER_SYNONYMS: Record<string, Array<keyof MapLayers>> = {
  aviation: ['flights'],
  flight: ['flights'],
  airplane: ['flights'],
  plane: ['flights'],
  notam: ['flights'],
  tfr: ['flights'],
  airspace: ['flights'],
  ship: ['ais', 'tradeRoutes'],
  vessel: ['ais'],
  maritime: ['ais', 'waterways', 'tradeRoutes'],
  sea: ['ais', 'waterways', 'cables'],
  ocean: ['cables', 'waterways'],
  war: ['conflicts', 'ucdpEvents', 'military'],
  battle: ['conflicts', 'ucdpEvents'],
  army: ['military', 'bases'],
  navy: ['military', 'ais'],
  missile: ['iranAttacks', 'military'],
  nuke: ['nuclear'],
  radiation: ['nuclear'],
  anomaly: ['climate'],
  internet: ['outages', 'cables', 'cyberThreats'],
  cyber: ['cyberThreats', 'outages'],
  hack: ['cyberThreats'],
  earthquake: ['natural'],
  volcano: ['natural'],
  tsunami: ['natural'],
  storm: ['weather', 'natural'],
  hurricane: ['weather', 'natural'],
  typhoon: ['weather', 'natural'],
  cyclone: ['weather', 'natural'],
  flood: ['weather', 'natural'],
  wildfire: ['fires'],
  forest: ['fires'],
  refugee: ['displacement'],
  migration: ['displacement'],
  riot: ['protests'],
  demonstration: ['protests'],
  oil: ['pipelines', 'commodityHubs'],
  gas: ['pipelines'],
  energy: ['pipelines', 'renewableInstallations'],
  solar: ['renewableInstallations'],
  wind: ['renewableInstallations'],
  green: ['renewableInstallations', 'speciesRecovery'],
  money: ['economic', 'financialCenters', 'stockExchanges'],
  bank: ['centralBanks', 'financialCenters'],
  stock: ['stockExchanges'],
  trade: ['tradeRoutes', 'waterways'],
  cloud: ['cloudRegions', 'datacenters'],
  ai: ['datacenters'],
  startup: ['startupHubs', 'accelerators'],
  tech: ['techHQs', 'techEvents', 'startupHubs', 'cloudRegions', 'datacenters'],
  gps: ['gpsJamming'],
  jamming: ['gpsJamming'],
  mineral: ['minerals', 'miningSites'],
  mining: ['miningSites'],
  port: ['commodityPorts'],
  happy: ['happiness', 'kindness', 'positiveEvents'],
  good: ['positiveEvents', 'kindness'],
  animal: ['speciesRecovery'],
  wildlife: ['speciesRecovery'],
  gulf: ['gulfInvestments'],
  gcc: ['gulfInvestments'],
  sanction: ['sanctions'],
  reservoir: ['reservoirLevels'],
  reservoirs: ['reservoirLevels'],
  dam: ['reservoirLevels'],
  dams: ['reservoirLevels'],
  lake: ['reservoirLevels'],
  lakes: ['reservoirLevels'],
  water: ['reservoirLevels'],
  hydropower: ['reservoirLevels'],
  no2: ['no2Activity'],
  emissions: ['no2Activity'],
  pollution: ['no2Activity'],
  industrial: ['no2Activity'],
  satellite: ['no2Activity'],
  webcam: ['webcams'],
  camera: ['webcams'],
  livecam: ['webcams'],
};

export function resolveLayerLabel(def: LayerDefinition, tFn?: (key: string) => string): string {
  if (tFn) {
    const translated = tFn(I18N_PREFIX + def.i18nSuffix);
    if (translated && translated !== I18N_PREFIX + def.i18nSuffix) return translated;
  }
  return def.fallbackLabel;
}

export function hasCuratedLayerExplanation(layerKey: keyof MapLayers): boolean {
  return LAYER_EXPLANATIONS[layerKey]?.coverage === 'curated';
}

export function getLayerExplanation(layerKey: keyof MapLayers): LayerExplanation {
  const curated = LAYER_EXPLANATIONS[layerKey];
  if (curated) return curated;

  return {
    key: layerKey,
    coverage: 'fallback',
    evidence: [],
  };
}

export interface MapLayerGroupDef {
  readonly id: string;
  readonly labelKo: string;
  readonly labelEn: string;
  readonly keys: readonly (keyof MapLayers)[];
}

export interface MapLayerPresetDef {
  readonly id: string;
  readonly labelKo: string;
  readonly labelEn: string;
  readonly layers: readonly (keyof MapLayers)[];
}

/** 6 logical groups organizing all map layers for scannable accordion browsing. */
export const MAP_LAYER_GROUPS: readonly MapLayerGroupDef[] = [
  {
    id: 'conflict',
    labelKo: '분쟁 · 안보',
    labelEn: 'Conflict & Security',
    keys: ['hotspots', 'conflicts', 'iranAttacks', 'ucdpEvents', 'protests', 'sanctions', 'displacement'],
  },
  {
    id: 'military',
    labelKo: '군사 · 항공 · 해상',
    labelEn: 'Military & Transport',
    keys: ['bases', 'military', 'flights', 'aircraftEmergencies', 'ais', 'liveTankers', 'gpsJamming'],
  },
  {
    id: 'infra',
    labelKo: '에너지 · 인프라 · 사이버',
    labelEn: 'Energy & Infra',
    keys: ['pipelines', 'storageFacilities', 'fuelShortages', 'cables', 'outages', 'datacenters', 'cyberThreats', 'nuclear'],
  },
  {
    id: 'economic',
    labelKo: '경제 · 무역 · 자원',
    labelEn: 'Economy & Trade',
    keys: [
      'waterways', 'economic', 'tradeRoutes', 'minerals', 'no2Activity',
      'stockExchanges', 'financialCenters', 'centralBanks', 'commodityHubs', 'gulfInvestments',
      'miningSites', 'processingPlants', 'commodityPorts',
      'startupHubs', 'techHQs', 'accelerators', 'cloudRegions', 'techEvents',
    ],
  },
  {
    id: 'hazards',
    labelKo: '자연 · 기상 · 보건',
    labelEn: 'Nature & Hazards',
    keys: ['natural', 'weather', 'fires', 'climate', 'reservoirLevels', 'diseaseOutbreaks'],
  },
  {
    id: 'overlays',
    labelKo: '국가 지표 · 오버레이',
    labelEn: 'Indicators & Overlays',
    keys: ['ciiChoropleth', 'webcams', 'positiveEvents', 'kindness', 'happiness', 'speciesRecovery', 'renewableInstallations'],
  },
] as const;

/** One-click layer presets for the map HUD drawer. */
export const MAP_LAYER_PRESETS: readonly MapLayerPresetDef[] = [
  {
    id: 'core',
    labelKo: '기본 6',
    labelEn: 'Core 6',
    layers: ['conflicts', 'hotspots', 'natural', 'weather', 'waterways', 'economic'],
  },
  {
    id: 'security',
    labelKo: '분쟁·군사',
    labelEn: 'Security',
    layers: ['conflicts', 'hotspots', 'military', 'bases', 'ucdpEvents', 'sanctions', 'ciiChoropleth'],
  },
  {
    id: 'energy',
    labelKo: '에너지·해운',
    labelEn: 'Energy',
    layers: ['pipelines', 'storageFacilities', 'waterways', 'tradeRoutes', 'ais', 'fuelShortages'],
  },
  {
    id: 'hazards',
    labelKo: '재난·기상',
    labelEn: 'Hazards',
    layers: ['natural', 'weather', 'fires', 'climate', 'outages', 'diseaseOutbreaks'],
  },
  {
    id: 'clear',
    labelKo: '모두 끄기',
    labelEn: 'Clear',
    layers: [],
  },
] as const;

export function bindLayerSearch(container: HTMLElement): void {
  const searchInput = container.querySelector('.layer-search') as HTMLInputElement | null;
  if (!searchInput) return;
  searchInput.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const synonymHits = new Set<string>();
    if (q) {
      for (const [alias, keys] of Object.entries(LAYER_SYNONYMS)) {
        if (alias.includes(q)) keys.forEach(k => synonymHits.add(k));
      }
    }
    container.querySelectorAll('.layer-toggle').forEach(label => {
      const el = label as HTMLElement;
      if (el.hasAttribute('data-layer-hidden')) return;
      const row = el.closest('.layer-toggle-row') as HTMLElement | null;
      const displayTarget = row ?? el;
      if (!q) { displayTarget.style.display = ''; return; }
      const key = label.getAttribute('data-layer') || '';
      const text = label.textContent?.toLowerCase() || '';
      const match = text.includes(q) || key.toLowerCase().includes(q) || synonymHits.has(key);
      displayTarget.style.display = match ? '' : 'none';
    });
    container.querySelectorAll<HTMLDetailsElement>('.layer-group').forEach(group => {
      const rows = Array.from(group.querySelectorAll<HTMLElement>('.layer-toggle-row'));
      if (!q) {
        group.style.display = '';
        if (group.dataset.defaultOpen === 'true') group.open = true;
        return;
      }
      const hasVisible = rows.some(r => r.style.display !== 'none' && !r.querySelector('[data-layer-hidden]'));
      group.style.display = hasVisible ? '' : 'none';
      if (hasVisible) group.open = true;
    });
  });
}
