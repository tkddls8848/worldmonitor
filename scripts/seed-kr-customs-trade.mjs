#!/usr/bin/env node
import { XMLParser } from 'fast-xml-parser';
import { loadEnvFile, runSeed } from './_seed-utils.mjs';

export const CACHE_KEY = 'kr:customs-trade:v1';
const BASE = 'https://apis.data.go.kr/1220000';
const UA = 'WorldMonitor-Personal-Collect/1.0 (kr-customs-trade)';
const TTL_SECONDS = 5 * 24 * 60 * 60;
const COUNTRIES = ['CN', 'US', 'VN', 'JP', 'HK', 'TW', 'DE', 'AU', 'SG', 'IN', 'MX', 'RU', 'TH', 'MY', 'CA', 'ID'];
const ITEM_NAMES = { '8542': '반도체', '8703': '승용차', '2710': '석유제품', '8901': '선박', '8517': '무선통신기기', '8524': '디스플레이' };
const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, trimValues: true });
let requestQueue = Promise.resolve();
let nextRequestAt = 0;

function pacedFetch(url, options, fetchImpl) {
  const request = requestQueue.then(async () => {
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    nextRequestAt = Date.now() + 150;
    return fetchImpl(url, options);
  });
  requestQueue = request.catch(() => {});
  return request;
}

function rowsFromJson(data) {
  const root = data?.response ?? data;
  const header = root?.header ?? root?.response?.header;
  if (header && String(header.resultCode ?? '') !== '00') {
    throw new Error(`data.go.kr ${header.resultCode}: ${header.resultMsg ?? 'unknown service error'}`);
  }
  const serialized = JSON.stringify(root);
  if (serialized.includes('SERVICE_KEY_IS_NOT_REGISTERED')) throw new Error('data.go.kr SERVICE_KEY_IS_NOT_REGISTERED (newly approved service keys may take time to activate)');
  const serviceMessage = root?.cmmMsgHeader?.returnAuthMsg ?? root?.OpenAPI_ServiceResponse?.cmmMsgHeader?.returnAuthMsg;
  if (serviceMessage) throw new Error(`data.go.kr ${serviceMessage}`);
  const items = root?.body?.items?.item ?? root?.body?.items ?? root?.items?.item ?? root?.items ?? [];
  return Array.isArray(items) ? items : items ? [items] : [];
}

export function parseTradeResponse(body) {
  const source = typeof body === 'string' ? body.trim() : body;
  let json;
  if (typeof source === 'string') {
    if (!source.startsWith('<')) {
      try { json = JSON.parse(source); } catch { throw new Error('Unexpected data.go.kr response format'); }
    } else {
      try { json = parser.parse(source); } catch { throw new Error('Malformed data.go.kr XML response'); }
    }
  } else json = source;
  return rowsFromJson(json);
}

export function percentChange(current, previous) { return previous > 0 ? ((current - previous) / previous) * 100 : null; }

const num = (value) => {
  const parsed = Number(String(value ?? '').replaceAll(',', ''));
  return Number.isFinite(parsed) ? parsed : 0;
};
const yoy = percentChange;
const monthString = (date) => `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
const priorYear = (month) => `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;

async function fetchRows(service, operation, params, apiKey, fetchImpl) {
  const url = new URL(`${BASE}/${service}/${operation}`);
  url.searchParams.set('serviceKey', apiKey);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await pacedFetch(url, { headers: { Accept: 'application/json, application/xml, text/xml', 'User-Agent': UA }, signal: AbortSignal.timeout(30_000) }, fetchImpl);
  const body = await response.text();
  if (!response.ok) throw new Error(`data.go.kr HTTP ${response.status}`);
  const rows = parseTradeResponse(body);
  if (!rows.length) throw new Error('data.go.kr returned no trade rows');
  return rows;
}

function aggregateRows(rows, codeField) {
  const result = new Map();
  for (const row of rows) {
    const code = String(row[codeField] ?? '').replace(/\D/g, '').slice(0, 4);
    if (!code || code.length !== 4) continue;
    const agg = result.get(code) ?? { hs: code, nameKo: ITEM_NAMES[code] ?? String(row.statKor ?? code), exportUsd: 0, importUsd: 0 };
    agg.exportUsd += num(row.expDlr);
    agg.importUsd += num(row.impDlr);
    if (!ITEM_NAMES[code] && row.statKor) agg.nameKo = String(row.statKor);
    result.set(code, agg);
  }
  return [...result.values()];
}

function totalFromItemRows(rows) {
  const totalRow = rows.find((row) => String(row.year ?? '') === '총계' || String(row.hsCode ?? '') === '-');
  if (totalRow) return { exportUsd: num(totalRow.expDlr), importUsd: num(totalRow.impDlr) };
  return rows.reduce((sum, row) => ({ exportUsd: sum.exportUsd + num(row.expDlr), importUsd: sum.importUsd + num(row.impDlr) }), { exportUsd: 0, importUsd: 0 });
}

export function countryFromRows(rows, iso2) {
  const row = rows.find((item) => String(item.year ?? '').includes('총계'));
  if (row) return { iso2, nameKo: String(rows.find((item) => item.statCd === iso2)?.statCdCntnKor1 ?? iso2), exportUsd: num(row.expDlr), importUsd: num(row.impDlr) };
  const filtered = rows.filter((item) => item.statCd === iso2);
  if (!filtered.length) return null;
  return { iso2, nameKo: String(filtered[0].statCdCntnKor1 ?? iso2), exportUsd: filtered.reduce((a, r) => a + num(r.expDlr), 0), importUsd: filtered.reduce((a, r) => a + num(r.impDlr), 0) };
}

export async function buildSnapshot({ apiKey, fetchImpl = fetch, now = new Date() }) {
  if (!apiKey) throw new Error('DATA_GO_KR_SERVICE_KEY is not configured');
  const currentMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const month = monthString(currentMonth);
  const previousMonth = priorYear(month);
  const monthParams = (value) => ({ strtYymm: value, endYymm: value });

  // Itemtrade is the all-country monthly table; nitemtrade adds the required partner filter.
  const [totalRows, previousTotalRows, ...countryResults] = await Promise.all([
    fetchRows('Itemtrade', 'getItemtradeList', monthParams(month), apiKey, fetchImpl),
    fetchRows('Itemtrade', 'getItemtradeList', monthParams(previousMonth), apiKey, fetchImpl),
    ...COUNTRIES.flatMap((iso2) => [month, previousMonth].map((period) => fetchRows('nitemtrade', 'getNitemtradeList', { ...monthParams(period), cntyCd: iso2 }, apiKey, fetchImpl).then((rows) => ({ iso2, period, rows }))))
  ]);

  const totalNow = totalFromItemRows(totalRows);
  const totalBefore = totalFromItemRows(previousTotalRows);
  const byCountry = new Map();
  for (const entry of countryResults) {
    const pair = byCountry.get(entry.iso2) ?? {};
    pair[entry.period === month ? 'current' : 'previous'] = countryFromRows(entry.rows, entry.iso2);
    byCountry.set(entry.iso2, pair);
  }
  const partners = [...byCountry.entries()].flatMap(([iso2, pair]) => {
    if (!pair.current) return [];
    return [{ ...pair.current, exportYoyPct: pair.previous ? yoy(pair.current.exportUsd, pair.previous.exportUsd) : null }];
  }).sort((a, b) => b.exportUsd - a.exportUsd).slice(0, 10);

  const currentItems = aggregateRows(totalRows, 'hsCode');
  const previousItems = new Map(aggregateRows(previousTotalRows, 'hsCode').map((item) => [item.hs, item]));
  const selected = new Set(Object.keys(ITEM_NAMES));
  const topItemCodes = new Set([...currentItems].sort((a, b) => b.exportUsd - a.exportUsd).slice(0, 10).map((item) => item.hs));
  const items = currentItems.filter((item) => selected.has(item.hs) || topItemCodes.has(item.hs))
    .map((item) => ({ hs: item.hs, nameKo: ITEM_NAMES[item.hs] ?? item.nameKo, exportUsd: item.exportUsd, exportYoyPct: yoy(item.exportUsd, previousItems.get(item.hs)?.exportUsd ?? 0) }))
    .sort((a, b) => b.exportUsd - a.exportUsd);

  let provisional = null;
  try {
    const provisionalService = async (service, operation, period) => fetchRows(service, operation, monthParams(period), apiKey, fetchImpl);
    const provisionalMonth = monthString(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
    const [expNow, impNow, expPrev] = await Promise.all([
      provisionalService('prlstMmUtPrviExpAcrs', 'getPrlstMmUtPrviExpAcrs', provisionalMonth),
      provisionalService('prlstMmUtPrviImpAcrs', 'getPrlstMmUtPrviImpAcrs', provisionalMonth),
      provisionalService('prlstMmUtPrviExpAcrs', 'getPrlstMmUtPrviExpAcrs', priorYear(provisionalMonth)),
    ]);
    const exp = expNow[0], imp = impNow[0];
    const comparable = expPrev.find((row) => String(row.priodDt) === String(exp?.priodDt));
    if (exp && imp && exp.priodDt === imp.priodDt) provisional = {
      period: `${exp.priodMon ?? provisionalMonth} ${exp.priodDt}`,
      exportUsd: num(exp.itemUsdAmt00) * 1000, importUsd: num(imp.itemUsdAmt00) * 1000,
      exportYoyPct: comparable ? yoy(num(exp.itemUsdAmt00), num(comparable.itemUsdAmt00)) : null,
    };
  } catch (error) {
    console.warn(`[kr-customs-trade] 10-day provisional feed unavailable: ${error?.message ?? error}`);
    // Monthly data remains useful if the separate provisional services are not enabled.
  }

  return {
    asOf: Date.now(), month,
    total: { exportUsd: totalNow.exportUsd, importUsd: totalNow.importUsd, balanceUsd: totalNow.exportUsd - totalNow.importUsd,
      exportYoyPct: yoy(totalNow.exportUsd, totalBefore.exportUsd), importYoyPct: yoy(totalNow.importUsd, totalBefore.importUsd) },
    partners, items, provisional,
  };
}

export function validateSnapshot(value) {
  return Boolean(value && Number.isFinite(value.asOf) && /^\d{6}$/.test(value.month)
    && Number.isFinite(value.total?.exportUsd) && Number.isFinite(value.total?.importUsd)
    && Array.isArray(value.partners) && Array.isArray(value.items));
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  loadEnvFile(import.meta.url);
  await runSeed('kr-customs-trade', 'monthly', CACHE_KEY, () => buildSnapshot({ apiKey: process.env.DATA_GO_KR_SERVICE_KEY }), {
    ttlSeconds: TTL_SECONDS, sourceVersion: 'kr-customs-trade-v1', schemaVersion: 1, maxStaleMin: 4320,
    validateFn: validateSnapshot, declareRecords: (data) => data.partners.length + data.items.length + 1,
  });
}
