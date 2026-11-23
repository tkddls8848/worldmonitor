const SAMPLE_SIZE = 6;

function stats(rows, key) {
  const values = rows.map((row) => row[key]);
  if (values.length !== SAMPLE_SIZE || !values.every(Number.isFinite)) return null;
  const mean = values.reduce((sum, value) => sum + value, 0) / SAMPLE_SIZE;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (SAMPLE_SIZE - 1);
  return { mean, sd: Math.sqrt(variance) };
}

// Compare with the six immediately preceding auctions of the same kind and
// original tenor. One material move can flag a result, but opposing moves cancel.
export function compareAuctionDemand(auction, previous) {
  const sample = previous.slice(-SAMPLE_SIZE);
  const cover = stats(sample, 'bidToCover');
  const dealer = stats(sample, 'dealerSharePct');
  const indirect = stats(sample, 'indirectSharePct');
  let verdict = 'insufficient';
  if (cover && dealer && Number.isFinite(auction.bidToCover) && Number.isFinite(auction.dealerSharePct)) {
    const coverDelta = auction.bidToCover - cover.mean;
    const dealerDelta = auction.dealerSharePct - dealer.mean;
    const coverThreshold = Math.max(cover.sd, 0.05);
    const dealerThreshold = Math.max(dealer.sd, 2);
    const weak = coverDelta < -coverThreshold || dealerDelta > dealerThreshold;
    const strong = coverDelta > coverThreshold || dealerDelta < -dealerThreshold;
    verdict = weak === strong ? 'neutral' : weak ? 'weak' : 'strong';
  }
  return {
    verdict,
    trailing: {
      bidToCover: cover?.mean ?? null,
      dealerSharePct: dealer?.mean ?? null,
      indirectSharePct: indirect?.mean ?? null,
    },
  };
}
