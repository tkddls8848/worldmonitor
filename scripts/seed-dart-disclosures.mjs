import { CHROME_UA, loadEnvFile, runSeed } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

export const DART_DISCLOSURES_KEY = 'kr:dart-disclosures:v1';
export const DART_DISCLOSURES_TTL_SECONDS = 90 * 60;
export const DART_LIST_URL = 'https://opendart.fss.or.kr/api/list.json';
const PAGE_COUNT = 100;
const QUERY_TYPES = [
  { type: 'B', details: ['B001'], kind: 'major' },
  { type: 'D', details: ['D001', 'D002'], kind: 'ownership' },
  { type: 'I', details: ['I001', 'I002'], kind: 'exchange' },
];

export function kstDateString(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(date).replaceAll('-', '');
}

export function dateRangeKst(now = new Date()) {
  const today = kstDateString(now);
  const day = new Date(`${today.slice(0, 4)}-${today.slice(4, 6)}-${today.slice(6, 8)}T00:00:00+09:00`);
  day.setUTCDate(day.getUTCDate() - 2);
  return { bgn_de: kstDateString(day), end_de: today };
}

export function receiptTimeKst(value) {
  if (!/^\d{8}$/.test(value ?? '')) throw new Error(`Invalid DART receipt date: ${value}`);
  const timestamp = Date.parse(`${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T00:00:00+09:00`);
  if (!Number.isFinite(timestamp)) throw new Error(`Invalid DART receipt date: ${value}`);
  return timestamp;
}

export function classifyDartStatus(payload) {
  if (payload?.status === '000') return 'ok';
  if (payload?.status === '013') return 'empty';
  const detail = `OpenDART ${payload?.status ?? 'unknown'}: ${payload?.message ?? 'unknown response'}`;
  throw new Error(detail);
}

export function mapDartDisclosure(row, kind) {
  if (!row?.rcept_no || !row?.rcept_dt || !row?.corp_name || !row?.report_nm) return null;
  if (!['Y', 'K'].includes(row.corp_cls)) return null;
  return {
    id: row.rcept_no,
    at: receiptTimeKst(row.rcept_dt),
    corpName: row.corp_name,
    stockCode: /^\d{6}$/.test(row.stock_code ?? '') ? row.stock_code : null,
    market: row.corp_cls === 'Y' ? 'KOSPI' : 'KOSDAQ',
    kind,
    title: row.report_nm,
    filer: row.flr_nm ?? '',
    url: `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${encodeURIComponent(row.rcept_no)}`,
  };
}

const isMarketMovingExchange = (title) => /단일판매|공급계약|공정공시/u.test(title);

export function rankDartDisclosures(items, cap = 80) {
  return items
    .filter((item) => item.kind !== 'exchange' || isMarketMovingExchange(item.title))
    .sort((a, b) => (a.market === b.market ? 0 : a.market === 'KOSPI' ? -1 : 1)
      || ({ major: 0, ownership: 1, exchange: 2 }[a.kind] - { major: 0, ownership: 1, exchange: 2 }[b.kind])
      || b.at - a.at)
    .slice(0, cap);
}

async function fetchPage(params, fetchFn = fetch) {
  const response = await fetchFn(`${DART_LIST_URL}?${new URLSearchParams(params)}`, {
    headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`OpenDART HTTP ${response.status}`);
  const payload = await response.json();
  const status = classifyDartStatus(payload);
  return status === 'empty' ? [] : (Array.isArray(payload.list) ? payload.list : []);
}

export async function fetchDartDisclosures({ apiKey = process.env.OPENDART_API_KEY, now = new Date(), fetchFn = fetch } = {}) {
  if (!apiKey) throw new Error('OPENDART_API_KEY is required');
  const dates = dateRangeKst(now);
  const rows = [];
  for (const corp_cls of ['Y', 'K']) {
    for (const query of QUERY_TYPES) {
      for (const pblntf_detail_ty of query.details) {
        const page = await fetchPage({
          crtfc_key: apiKey, ...dates, pblntf_ty: query.type,
          pblntf_detail_ty, corp_cls, page_no: '1', page_count: String(PAGE_COUNT),
        }, fetchFn);
        for (const row of page) {
          const item = mapDartDisclosure(row, query.kind);
          if (item) rows.push(item);
        }
      }
    }
  }
  const unique = [...new Map(rows.map((row) => [row.id, row])).values()];
  return { asOf: Date.now(), items: rankDartDisclosures(unique) };
}

if (process.argv[1]?.endsWith('seed-dart-disclosures.mjs')) {
  runSeed('market', 'dart-disclosures', DART_DISCLOSURES_KEY, fetchDartDisclosures, {
    ttlSeconds: DART_DISCLOSURES_TTL_SECONDS,
    sourceVersion: 'opendart-disclosures-v1',
    schemaVersion: 1,
    maxStaleMin: 180,
    validateFn: (value) => Number.isFinite(value?.asOf) && Array.isArray(value?.items) && value.items.length <= 80,
    declareRecords: (value) => value.items.length,
    zeroIsValid: true,
  });
}
