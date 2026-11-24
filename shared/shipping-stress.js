export const SHIPPING_CARRIERS = [
  { symbol: 'BDRY', name: 'Breakwave Dry Bulk ETF',  carrierType: 'etf' },
  { symbol: 'ZIM',  name: 'ZIM Integrated Shipping', carrierType: 'carrier' },
  { symbol: 'MATX', name: 'Matson Inc',              carrierType: 'carrier' },
  { symbol: 'SBLK', name: 'Star Bulk Carriers',      carrierType: 'carrier' },
  { symbol: 'EGLE', name: 'Eagle Bulk Shipping',       carrierType: 'carrier' },
];

export function scoreShippingStress(results) {
  const avgChange = results.reduce((a, b) => a + b.changePct, 0) / results.length;
  // Neutral market (0% change) → score=40 (moderate). Positive change = lower stress.
  const stressScore = Math.min(100, Math.max(0, Math.round(40 - avgChange * 3)));
  const stressLevel = stressScore >= 75 ? 'critical' : stressScore >= 50 ? 'elevated' : stressScore >= 25 ? 'moderate' : 'low';
  return { stressScore, stressLevel };
}
