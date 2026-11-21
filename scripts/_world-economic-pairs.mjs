const COMTRADE_PARTNERS = Object.freeze({ 490: 'TW' });

export function tradeDependencePairs(reports, topN = 40) {
  const totals = new Map();
  let asOfYear = null;
  for (const report of reports || []) {
    const importer = String(report?.iso2 || '').toUpperCase();
    if (!/^[A-Z]{2}$/.test(importer)) continue;
    for (const product of report.products || []) {
      if (Number.isInteger(product.year)) asOfYear = Math.max(asOfYear ?? product.year, product.year);
      for (const exporterRecord of product.topExporters || []) {
        const exporter = String(exporterRecord.partnerIso2 || COMTRADE_PARTNERS[exporterRecord.partnerCode] || '').toUpperCase();
        const valueUsd = Number(exporterRecord.value);
        if (!/^[A-Z]{2}$/.test(exporter) || exporter === importer || !Number.isFinite(valueUsd) || valueUsd <= 0) continue;
        const key = `${exporter}>${importer}`;
        totals.set(key, (totals.get(key) || 0) + valueUsd);
      }
    }
  }
  const pairs = [...totals].map(([key, valueUsd]) => {
    const [from, to] = key.split('>');
    return { from, to, valueUsd };
  }).sort((a, b) => b.valueUsd - a.valueUsd || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)).slice(0, topN);
  return { pairs, asOfYear };
}

export function bankClaimPairs(countries, topN = 20) {
  const pairs = [];
  for (const [borrower, data] of Object.entries(countries || {})) {
    for (const [lender, millions] of Object.entries(data?.parents || {})) {
      const value = Number(millions);
      if (!/^[A-Z]{2}$/.test(borrower) || !/^[A-Z]{2}$/.test(lender) || borrower === lender || !Number.isFinite(value) || value <= 0) continue;
      pairs.push({ from: lender, to: borrower, valueUsd: value * 1_000_000 });
    }
  }
  return pairs.sort((a, b) => b.valueUsd - a.valueUsd || a.from.localeCompare(b.from) || a.to.localeCompare(b.to)).slice(0, topN);
}
