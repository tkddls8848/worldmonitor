import { safeStorageSet } from '@/utils/safe-storage';

export type RuntimeSecretKey =
  | 'OPENROUTER_API_KEY'
  | 'EXA_API_KEYS'
  | 'BRAVE_API_KEYS'
  | 'SERPAPI_API_KEYS'
  | 'FRED_API_KEY'
  | 'EIA_API_KEY'
  | 'CLOUDFLARE_API_TOKEN'
  | 'ACLED_ACCESS_TOKEN'
  | 'URLHAUS_AUTH_KEY'
  | 'OTX_API_KEY'
  | 'ABUSEIPDB_API_KEY'
  | 'WINGBITS_API_KEY'
  | 'WS_RELAY_URL'
  | 'VITE_OPENSKY_RELAY_URL'
  | 'OPENSKY_CLIENT_ID'
  | 'OPENSKY_CLIENT_SECRET'
  | 'AISSTREAM_API_KEY'
  | 'FINNHUB_API_KEY'
  | 'NASA_FIRMS_API_KEY'
  | 'UCDP_ACCESS_TOKEN'
  | 'OLLAMA_API_URL'
  | 'OLLAMA_MODEL'
  | 'WORLDMONITOR_API_KEY'
  | 'WTO_API_KEY'
  | 'ICAO_API_KEY';

export type RuntimeFeatureId =
  | 'aiOpenRouter'
  | 'stockNewsSearchExa'
  | 'stockNewsSearchBrave'
  | 'stockNewsSearchSerpApi'
  | 'economicFred'
  | 'energyEia'
  | 'internetOutages'
  | 'acledConflicts'
  | 'abuseChThreatIntel'
  | 'alienvaultOtxThreatIntel'
  | 'abuseIpdbThreatIntel'
  | 'wingbitsEnrichment'
  | 'aisRelay'
  | 'openskyRelay'
  | 'militaryFlights'
  | 'finnhubMarkets'
  | 'nasaFirms'
  | 'aiOllama'
  | 'wtoTrade'
  | 'supplyChain'
  | 'ucdpConflicts'
  | 'icaoNotams';

export interface RuntimeFeatureDefinition {
  id: RuntimeFeatureId;
  name: string;
  description: string;
  requiredSecrets: RuntimeSecretKey[];
  fallback: string;
}

export interface RuntimeConfig {
  featureToggles: Record<RuntimeFeatureId, boolean>;
}

const TOGGLES_STORAGE_KEY = 'worldmonitor-runtime-feature-toggles';

const defaultToggles: Record<RuntimeFeatureId, boolean> = {
  aiOpenRouter: true,
  stockNewsSearchExa: true,
  stockNewsSearchBrave: true,
  stockNewsSearchSerpApi: true,
  economicFred: true,
  energyEia: true,
  internetOutages: true,
  acledConflicts: true,
  ucdpConflicts: true,
  abuseChThreatIntel: true,
  alienvaultOtxThreatIntel: true,
  abuseIpdbThreatIntel: true,
  wingbitsEnrichment: true,
  aisRelay: true,
  openskyRelay: true,
  militaryFlights: true,
  finnhubMarkets: true,
  nasaFirms: true,
  aiOllama: true,
  wtoTrade: true,
  supplyChain: true,
  icaoNotams: true,
};

export const RUNTIME_FEATURES: RuntimeFeatureDefinition[] = [
  {
    id: 'aiOllama',
    name: 'Ollama local summarization',
    description: 'Local LLM provider via OpenAI-compatible endpoint (Ollama or LM Studio, desktop-first).',
    requiredSecrets: ['OLLAMA_API_URL', 'OLLAMA_MODEL'],
    fallback: 'Falls back to OpenRouter, then local browser model.',
  },
  {
    id: 'aiOpenRouter',
    name: 'OpenRouter summarization',
    description: 'Hosted LLM provider used for AI summary generation.',
    requiredSecrets: ['OPENROUTER_API_KEY'],
    fallback: 'Falls back to local browser model only.',
  },
  {
    id: 'stockNewsSearchExa',
    name: 'Exa stock-news search',
    description: 'Primary targeted stock-news search provider for premium analysis enrichment.',
    requiredSecrets: ['EXA_API_KEYS'],
    fallback: 'Falls back to Brave, then SerpAPI, then Google News RSS.',
  },
  {
    id: 'stockNewsSearchBrave',
    name: 'Brave stock-news search',
    description: 'Fallback targeted stock-news provider for premium analysis enrichment.',
    requiredSecrets: ['BRAVE_API_KEYS'],
    fallback: 'Falls back to SerpAPI, then Google News RSS.',
  },
  {
    id: 'stockNewsSearchSerpApi',
    name: 'SerpAPI stock-news search',
    description: 'Additional targeted stock-news provider for premium analysis enrichment.',
    requiredSecrets: ['SERPAPI_API_KEYS'],
    fallback: 'Falls back to Google News RSS.',
  },
  {
    id: 'economicFred',
    name: 'FRED economic indicators',
    description: 'Macro indicators from Federal Reserve Economic Data.',
    requiredSecrets: ['FRED_API_KEY'],
    // Desktop reads this from the cloud seed cache; no local key is used (#5829).
    fallback: 'Economic panel remains available with non-FRED metrics.',
  },
  {
    id: 'energyEia',
    name: 'EIA oil analytics',
    description: 'US Energy Information Administration oil metrics.',
    requiredSecrets: ['EIA_API_KEY'],
    // Desktop reads this from the cloud seed cache; no local key is used (#5829).
    fallback: 'Oil analytics cards show disabled state.',
  },
  {
    id: 'internetOutages',
    name: 'Cloudflare outage radar',
    description: 'Internet outages from Cloudflare Radar annotations API.',
    requiredSecrets: ['CLOUDFLARE_API_TOKEN'],
    // Desktop reads this from the cloud seed cache; no local key is used (#5829).
    fallback: 'Outage layer is disabled and map continues with other feeds.',
  },
  {
    id: 'acledConflicts',
    name: 'ACLED conflicts & protests',
    description: 'Conflict and protest event feeds from ACLED.',
    requiredSecrets: ['ACLED_ACCESS_TOKEN'],
    fallback: 'Conflict/protest overlays are hidden.',
  },
  {
    id: 'ucdpConflicts',
    name: 'UCDP conflict events',
    description: 'Armed conflict georeferenced event data from Uppsala Conflict Data Program.',
    requiredSecrets: ['UCDP_ACCESS_TOKEN'],
    fallback: 'UCDP conflict layer is disabled.',
  },
  {
    id: 'abuseChThreatIntel',
    name: 'abuse.ch cyber IOC feeds',
    description: 'URLhaus and ThreatFox IOC ingestion for the cyber threat layer.',
    requiredSecrets: ['URLHAUS_AUTH_KEY'],
    fallback: 'URLhaus/ThreatFox IOC ingestion is disabled.',
  },
  {
    id: 'alienvaultOtxThreatIntel',
    name: 'AlienVault OTX threat intel',
    description: 'Optional OTX IOC ingestion for cyber threat enrichment.',
    requiredSecrets: ['OTX_API_KEY'],
    fallback: 'OTX IOC enrichment is disabled.',
  },
  {
    id: 'abuseIpdbThreatIntel',
    name: 'AbuseIPDB threat intel',
    description: 'Optional AbuseIPDB IOC/reputation enrichment for the cyber threat layer.',
    requiredSecrets: ['ABUSEIPDB_API_KEY'],
    fallback: 'AbuseIPDB enrichment is disabled.',
  },
  {
    id: 'wingbitsEnrichment',
    name: 'Wingbits aircraft enrichment',
    description: 'Military flight operator/aircraft enrichment metadata.',
    requiredSecrets: ['WINGBITS_API_KEY'],
    fallback: 'Flight map still renders with heuristic-only classification.',
  },
  {
    id: 'aisRelay',
    name: 'AIS vessel tracking',
    description: 'Live vessel ingestion via AISStream WebSocket.',
    requiredSecrets: ['WS_RELAY_URL', 'AISSTREAM_API_KEY'],
    fallback: 'AIS layer is disabled.',
  },
  {
    id: 'openskyRelay',
    name: 'OpenSky military flights (legacy)',
    description: 'OpenSky OAuth credentials for military flight data (legacy direct proxy).',
    requiredSecrets: ['VITE_OPENSKY_RELAY_URL', 'OPENSKY_CLIENT_ID', 'OPENSKY_CLIENT_SECRET'],
    fallback: 'Military flights fall back to limited/no data.',
  },
  {
    id: 'militaryFlights',
    name: 'Military flight tracking',
    description: 'Military flight data via Redis-backed edge handler (no credentials needed).',
    requiredSecrets: [],
    fallback: 'Military flights panel is disabled.',
  },
  {
    id: 'finnhubMarkets',
    name: 'Finnhub market data',
    description: 'Delayed or seeded stock quotes via Finnhub when configured. A key is not a live tape.',
    requiredSecrets: ['FINNHUB_API_KEY'],
    fallback: 'Stock ticker uses limited free data.',
  },
  {
    id: 'nasaFirms',
    name: 'NASA FIRMS fire data',
    description: 'Fire Information for Resource Management System satellite data.',
    requiredSecrets: ['NASA_FIRMS_API_KEY'],
    fallback: 'FIRMS fire layer uses public VIIRS feed.',
  },
  {
    id: 'wtoTrade',
    name: 'WTO trade policy data',
    description: 'Trade restrictions, tariff trends, barriers, and flows from WTO.',
    requiredSecrets: ['WTO_API_KEY'],
    // Desktop reads this from the cloud seed cache; no local key is used (#5829).
    fallback: 'Trade policy panel shows disabled state.',
  },
  {
    id: 'supplyChain',
    name: 'Supply Chain Intelligence',
    description: 'Shipping rates via FRED Baltic Dry Index. Chokepoints and minerals use public data.',
    requiredSecrets: ['FRED_API_KEY'],
    // Desktop reads this from the cloud seed cache; no local key is used (#5829).
    fallback: 'Chokepoints and minerals always available; shipping requires FRED key.',
  },
  {
    id: 'icaoNotams',
    name: 'ICAO NOTAM closures (Middle East)',
    description: 'Airport closure detection for MENA airports from ICAO NOTAM data service.',
    requiredSecrets: ['ICAO_API_KEY'],
    fallback: 'FAA NOTAM data remains available where configured.',
  },
];

function readStoredToggles(): Record<RuntimeFeatureId, boolean> {
  try {
    const stored = localStorage.getItem(TOGGLES_STORAGE_KEY);
    if (!stored) return { ...defaultToggles };
    const parsed = JSON.parse(stored) as Partial<Record<RuntimeFeatureId, boolean>>;
    return { ...defaultToggles, ...parsed };
  } catch {
    return { ...defaultToggles };
  }
}

const listeners = new Set<() => void>();

const runtimeConfig: RuntimeConfig = {
  featureToggles: readStoredToggles(),
};

function notifyConfigChanged(): void {
  for (const listener of listeners) listener();
}

// Listen for cross-window state updates (settings ↔ main).
// When one window toggles features, the `storage` event fires in other same-origin windows.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOGGLES_STORAGE_KEY && e.newValue) {
      try {
        const parsed = JSON.parse(e.newValue) as Partial<Record<RuntimeFeatureId, boolean>>;
        Object.assign(runtimeConfig.featureToggles, parsed);
        notifyConfigChanged();
      } catch { /* ignore malformed JSON */ }
    }
  });
}

export function subscribeRuntimeConfig(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getRuntimeConfigSnapshot(): RuntimeConfig {
  return {
    featureToggles: { ...runtimeConfig.featureToggles },
  };
}

export function isFeatureEnabled(featureId: RuntimeFeatureId): boolean {
  return runtimeConfig.featureToggles[featureId] !== false;
}

/** Cloud/web deployments validate credentials server-side, so a feature is available whenever it is enabled. */
export function isFeatureAvailable(featureId: RuntimeFeatureId): boolean {
  return isFeatureEnabled(featureId);
}

export function setFeatureToggle(featureId: RuntimeFeatureId, enabled: boolean): void {
  runtimeConfig.featureToggles[featureId] = enabled;
  safeStorageSet(TOGGLES_STORAGE_KEY, JSON.stringify(runtimeConfig.featureToggles));
  notifyConfigChanged();
}
