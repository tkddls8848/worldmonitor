const SOFR_URL = 'https://markets.newyorkfed.org/api/rates/secured/sofr/last/5.json';
const EFFR_URL = 'https://markets.newyorkfed.org/api/rates/unsecured/effr/last/5.json';
const RRP_URL = 'https://markets.newyorkfed.org/api/rp/reverserepo/all/results/last/5.json';
const OFR_FSI_URL = 'https://www.financialresearch.gov/financial-stress-index/data/fsi.csv';

export function parseRateRows(payload, type) {
  const rows = payload?.refRates;
  if (!Array.isArray(rows)) throw new Error('NY Fed response missing refRates');
  const sorted = rows.filter((row) => row?.type === type && Number.isFinite(Number(row.percentRate)) && /^\d{4}-\d{2}-\d{2}$/.test(row.effectiveDate))
    .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate));
  if (!sorted.length) return null;
  const latest = sorted[0];
  const previous = sorted.find((row) => row.effectiveDate < latest.effectiveDate);
  return { rate: Number(latest.percentRate), changeBp: previous ? Math.round((Number(latest.percentRate) - Number(previous.percentRate)) * 100 * 100) / 100 : null, date: latest.effectiveDate };
}

function csvRows(csv) {
  return csv.trim().split(/\r?\n/).map((line) => line.split(',').map((cell) => cell.trim()));
}

export function parseOfrCsv(csv) {
  const rows = csvRows(csv);
  const headers = rows.shift();
  const ix = Object.fromEntries(headers.map((header, i) => [header, i]));
  const required = ['Date', 'OFR FSI', 'Credit', 'Equity valuation', 'Funding', 'Safe assets', 'Volatility'];
  if (required.some((field) => ix[field] == null)) throw new Error('OFR CSV schema mismatch');
  const valid = rows.filter((row) => /^\d{4}-\d{2}-\d{2}$/.test(row[ix.Date]) && required.slice(1).every((field) => Number.isFinite(Number(row[ix[field]]))))
    .sort((a, b) => b[ix.Date].localeCompare(a[ix.Date]));
  if (!valid.length) throw new Error('OFR CSV has no usable observations');
  const [latest, previous] = valid;
  const components = Object.fromEntries(['Credit', 'Equity valuation', 'Funding', 'Safe assets', 'Volatility'].map((field) => [field, Number(latest[ix[field]])]));
  return { value: Number(latest[ix['OFR FSI']]), change1d: previous ? Number((Number(latest[ix['OFR FSI']]) - Number(previous[ix['OFR FSI']])).toFixed(6)) : null, date: latest[ix.Date], components };
}

export function parseRrp(payload) {
  const rows = payload?.repo?.operations ?? payload?.rp?.operations ?? payload?.operations;
  if (!Array.isArray(rows)) throw new Error('NY Fed reverse repo response missing operations');
  const sorted = rows.filter((row) => Number.isFinite(Number(row.totalAmtAccepted)) && /^\d{4}-\d{2}-\d{2}$/.test(row.operationDate))
    .sort((a, b) => b.operationDate.localeCompare(a.operationDate));
  if (!sorted.length) return null;
  const latest = sorted[0];
  const previous = sorted.find((row) => row.operationDate < latest.operationDate);
  return { amountBn: Number((Number(latest.totalAmtAccepted) / 1e9).toFixed(3)), change1dBn: previous ? Number(((Number(latest.totalAmtAccepted) - Number(previous.totalAmtAccepted)) / 1e9).toFixed(3)) : null, date: latest.operationDate };
}

export async function collectFundingStress(fetcher = globalThis.fetch) {
  const json = async (url) => { const response = await fetcher(url, { headers: { 'User-Agent': 'WorldMonitor/1.0 (personal data collector)' } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); };
  const text = async (url) => { const response = await fetcher(url, { headers: { 'User-Agent': 'WorldMonitor/1.0 (personal data collector)' } }); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.text(); };
  const safely = async (fn) => { try { return await fn(); } catch (error) { console.warn(`  funding source unavailable: ${error.message}`); return null; } };
  const [sofrData, effrData, rrpData, ofrText] = await Promise.all([
    safely(() => json(SOFR_URL)),
    safely(() => json(EFFR_URL)),
    safely(() => json(RRP_URL)),
    safely(() => text(OFR_FSI_URL)),
  ]);
  const parsed = (value, fn) => { try { return value == null ? null : fn(value); } catch (error) { console.warn(`  funding source parse failed: ${error.message}`); return null; } };
  const result = { asOf: Date.now(), sofr: parsed(sofrData, (v) => parseRateRows(v, 'SOFR')), effr: parsed(effrData, (v) => parseRateRows(v, 'EFFR')), rrp: parsed(rrpData, parseRrp), ofrFsi: parsed(ofrText, parseOfrCsv) };
  return Object.values(result).some((value) => value !== null) ? result : null;
}
