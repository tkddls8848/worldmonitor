export interface VariantMeta {
  title: string;
  description: string;
  keywords: string;
  url: string;
  siteName: string;
  shortName: string;
  subject: string;
  classification: string;
  categories: string[];
  features: string[];
}

export const VARIANT_META: { full: VariantMeta; [k: string]: VariantMeta } = {
  full: {
    title: 'World Monitor - Real-Time Global Intelligence Dashboard',
    description: 'Follow global conflicts, markets, shipping, and climate hazards live in 190+ countries, with country briefs and source-attributed reporting in one dashboard.',
    keywords: 'AI intelligence, AI-powered dashboard, global intelligence, geopolitical dashboard, world news, market data, military bases, nuclear facilities, undersea cables, conflict zones, real-time monitoring, situation awareness, OSINT, flight tracking, AIS ships, earthquake monitor, protest tracker, power outages, oil prices, government spending, polymarket predictions',
    url: 'https://www.worldmonitor.app/dashboard',
    siteName: 'World Monitor',
    shortName: 'World Monitor',
    subject: 'AI-Powered Global Intelligence and Situation Awareness',
    classification: 'AI Intelligence Dashboard, OSINT Tool, News Aggregator',
    categories: ['news', 'productivity'],
    features: [
      'Real-time news aggregation',
      'Stock market tracking',
      'Military flight monitoring',
      'Ship AIS tracking',
      'Earthquake alerts',
      'Protest tracking',
      'Power outage monitoring',
      'Oil price analytics',
      'Government spending data',
      'Prediction markets',
      'Infrastructure monitoring',
      'Geopolitical intelligence',
    ],
  },
  finance: {
    title: 'Finance Monitor - Real-Time Markets & Trading Dashboard',
    description: 'Real-time finance and trading dashboard tracking global markets, stock exchanges, central banks, commodities and forex, and economic indicators worldwide.',
    keywords: 'finance dashboard, trading dashboard, stock market, forex, commodities, central banks, economic indicators, market news, financial centers, stock exchanges, bonds, derivatives, fintech, hedge funds, IPO tracker, market analysis',
    url: 'https://finance.worldmonitor.app/dashboard',
    siteName: 'Finance Monitor',
    shortName: 'FinanceMonitor',
    subject: 'Global Markets, Trading, and Financial Intelligence',
    classification: 'Finance Dashboard, Market Tracker, Trading Intelligence',
    categories: ['finance', 'news'],
    features: [
      'Real-time market data',
      'Stock exchange mapping',
      'Central bank monitoring',
      'Commodity price tracking',
      'Forex & currency news',
      'Economic indicator alerts',
      'IPO & earnings tracking',
      'Financial center mapping',
      'Sector heatmap',
      'Market radar signals',
    ],
  },
  commodity: {
    title: 'Commodity Monitor: Live Commodity Markets & Supply Chains',
    description: 'Real-time commodity markets dashboard tracking mining sites, processing plants, commodity ports, supply chains, and global trade flows with live context.',
    keywords: 'commodity dashboard, mining sites, processing plants, commodity ports, supply chain, commodity markets, oil, gas, metals, agriculture, mining operations, commodity trade, logistics, infrastructure, resource tracking, commodity prices, futures markets',
    url: 'https://commodity.worldmonitor.app/dashboard',
    siteName: 'Commodity Monitor',
    shortName: 'CommodityMonitor',
    subject: 'Commodity Markets, Mining, and Supply Chain Intelligence',
    classification: 'Commodity Dashboard, Supply Chain Tracker, Resource Intelligence',
    categories: ['finance', 'business'],
    features: [
      'Mining site tracking',
      'Processing plant monitoring',
      'Commodity port mapping',
      'Supply chain visualization',
      'Commodity price tracking',
      'Trade flow analysis',
      'Resource extraction monitoring',
      'Logistics infrastructure',
      'Commodity market news',
      'Futures market data',
    ],
  },
  energy: {
    title: 'Energy Atlas - Live Global Energy Intelligence Dashboard',
    description: 'Real-time global energy atlas tracking oil and gas pipelines, storage facilities, chokepoints, fuel shortages, tanker flows, and disruption events worldwide.',
    keywords: 'energy dashboard, oil pipeline tracker, gas pipeline map, LNG terminals, gas storage map, oil storage, SPR tracker, Strait of Hormuz, chokepoint monitor, fuel shortage tracker, pipeline disruption, energy crisis, OPEC, tanker tracking, energy infrastructure, natural gas storage, crude oil inventories, IEA oil stocks, days of cover, energy sanctions, petroleum, diesel, jet fuel, heating oil',
    url: 'https://energy.worldmonitor.app/dashboard',
    siteName: 'Energy Atlas',
    shortName: 'EnergyAtlas',
    subject: 'Global Energy Infrastructure, Supply, and Disruption Intelligence',
    classification: 'Energy Dashboard, Pipeline Tracker, Supply Disruption Monitor',
    categories: ['news', 'business'],
    features: [
      'Oil & gas pipeline registry with live status',
      'Storage facility map (UGS, LNG, SPR, tank farms)',
      'Chokepoint flow monitoring (Hormuz, Suez, Malacca, Bab el-Mandeb)',
      'Fuel shortage alerts (jet, petrol, diesel, heating oil)',
      'Pipeline & storage disruption timeline',
      'Oil & gas inventories (EU gas, US SPR, IEA stocks)',
      'Retail fuel prices by country',
      'Energy crisis policy tracker',
      'Evidence-based status badges with public revision log',
      'Country energy exposure drill-down',
    ],
  },
};
