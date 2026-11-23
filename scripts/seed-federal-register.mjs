import { pathToFileURL } from 'node:url';
import { countryMentionTerms, mentionsCountry } from '../shared/country-mention.js';
import { loadEnvFile, loadSharedConfig, runSeed } from './_seed-utils.mjs';

const API = 'https://www.federalregister.gov/api/v1/documents.json';
const KEY = 'policy:federal-register:v1';
const TTL_SECONDS = 6 * 60 * 60;
const MAX_STALE_MIN = 180;
const PAGE_SIZE = 1000;
const MAX_PAGES = 5;
const MAX_ITEMS = 150;
const FIELDS = ['document_number', 'title', 'type', 'subtype', 'abstract', 'publication_date', 'html_url', 'agencies'];
const PRESIDENTIAL_SUBTYPES = new Set(['Executive Order', 'Proclamation', 'Memorandum', 'Determination']);
const AGENCY_TYPES = ['RULE', 'PRORULE', 'NOTICE'];
const TRADE_AGENCIES = ['trade-representative-office-of-united-states', 'international-trade-administration', 'commerce-department'];
const EXPORT_AGENCY = 'industry-and-security-bureau';
const SANCTIONS_AGENCIES = ['foreign-assets-control-office', 'treasury-department', 'state-department'];
const FINANCIAL_AGENCIES = ['federal-reserve-system', 'securities-and-exchange-commission', 'commodity-futures-trading-commission', 'treasury-department'];
const DEFENSE_AGENCIES = ['defense-department', 'state-department'];
const AGENCIES = [...new Set([...TRADE_AGENCIES, EXPORT_AGENCY, ...SANCTIONS_AGENCIES, ...FINANCIAL_AGENCIES, ...DEFENSE_AGENCIES])];
const AGENCY_DOCUMENT_TYPES = new Set(['Rule', 'Proposed Rule', 'Notice']);
const COUNTRY_TERMS = [...new Set(Object.values(loadSharedConfig('iso3-to-iso2.json')))].sort().map(countryMentionTerms);
const PUBLICATION_DAY = new Intl.DateTimeFormat('sv-SE', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const DAY_MS = 86_400_000;

const ROUTINE_NOTICE = /^(?:agency information collection(?: activities)?|information collection(?: activities)?|submission for omb review|sunshine act meetings?|privacy act of 1974|self-regulatory organizations?|combined notice of filings|notice of extension of (?:the )?deadline)\b/i;
const TARIFF = /\b(?:tariffs?|adjusting imports|(?:anti[- ]?dumping|countervailing|import|additional) dut(?:y|ies)|section (?:201|232|301)|harmonized tariff schedule|tariff-rate quotas?)\b/i;
const SANCTIONS = /\b(?:sanction(?:s|ing|ed)?|ofac|blocked persons|blocking (?:the )?property|specially designated nationals|foreign terrorist organization|iran nonproliferation)\b/i;
const EXPORT_CONTROL = /\b(?:export controls?|export administration regulations|entity list|unverified list|military end users?|commerce control list|reexports?|export (?:license|licensing|restrictions?)|temporary denial order)\b/i;
const FINANCIAL = /\b(?:monetary policy|interest on reserve balances|capital (?:requirements|adequacy)|stress tests?|financial stability|securities markets?|clearing (?:agencies|organizations)|swap dealers?|digital assets?|market structure|margin requirements|federal open market committee|discount rate|reserve requirements|bank supervision)\b/i;
const DEFENSE = /\b(?:national defense|defense production act|arms export control|arms sales?|security assistance|foreign military sales?|international traffic in arms|defense cooperation)\b/i;
const TRADE = /\b(?:trade agreements?|trade negotiations?|trade investigations?|import restrictions?|import quotas?|trade remedies|trade policy)\b/i;

function classifyDocument(title, type, subtype, agencies) {
  const presidential = type === 'Presidential Document';
  if (presidential ? !PRESIDENTIAL_SUBTYPES.has(subtype) : !AGENCY_DOCUMENT_TYPES.has(type) || ROUTINE_NOTICE.test(title)) return null;

  const from = (group) => group.some((agency) => agencies.includes(agency));
  if ((presidential || from(SANCTIONS_AGENCIES)) && SANCTIONS.test(title)) return 'sanctions';
  if ((presidential || agencies.includes(EXPORT_AGENCY) || from(DEFENSE_AGENCIES)) && EXPORT_CONTROL.test(title)) return 'export-control';
  if ((presidential || from(TRADE_AGENCIES)) && TARIFF.test(title)) return 'tariff';
  if ((presidential || from(FINANCIAL_AGENCIES)) && FINANCIAL.test(title)) return 'monetary/financial';
  if ((presidential || from(DEFENSE_AGENCIES)) && DEFENSE.test(title)) return 'defense';
  if (agencies.includes(EXPORT_AGENCY) && type !== 'Notice') return 'export-control';
  if (agencies.includes('foreign-assets-control-office')) return 'sanctions';
  if (presidential || (from(TRADE_AGENCIES) && TRADE.test(title))) return 'other';
  return null;
}

function matchCountries(title, abstract) {
  const headline = COUNTRY_TERMS.filter((terms) => mentionsCountry(title, terms)).map(({ code }) => code);
  const summary = abstract ? COUNTRY_TERMS.filter((terms) => mentionsCountry(abstract, terms)).map(({ code }) => code) : [];
  return [...new Set([...headline, ...summary])].sort((a, b) => Number(a === 'US') - Number(b === 'US'));
}

export function mapFederalRegisterDocuments(rows, from, through) {
  const items = new Map();
  for (const row of rows) {
    const id = row?.document_number;
    const title = typeof row?.title === 'string' ? row.title.trim() : '';
    const date = row?.publication_date;
    if (typeof id !== 'string' || !/^(?:[A-Z0-9]+-)*\d+$/.test(id) || !title || items.has(id)) continue;
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date < from || date > through) continue;
    const url = typeof row.html_url === 'string' ? URL.parse(row.html_url) : null;
    if (url?.origin !== 'https://www.federalregister.gov' || url.username || url.password
      || !url.pathname.startsWith(`/documents/${date.replaceAll('-', '/')}/${id}/`)) continue;

    const agencies = Array.isArray(row.agencies) ? row.agencies.map((agency) => agency?.slug) : [];
    const topic = classifyDocument(title, row.type, row.subtype, agencies);
    if (!topic) continue;
    items.set(id, {
      id,
      title,
      date,
      type: row.subtype || row.type,
      topic,
      countries: matchCountries(title, typeof row.abstract === 'string' ? row.abstract : ''),
      url: url.href,
    });
  }
  return [...items.values()]
    .sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id))
    .slice(0, MAX_ITEMS);
}

async function fetchDocuments(fetchImpl, params) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(API);
    url.search = params.toString();
    url.searchParams.set('page', String(page));
    const response = await fetchImpl(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'WorldMonitor/1.0 (Federal Register collector)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Federal Register documents HTTP ${response.status}`);
    const body = await response.json();
    if (page === 1 && body?.count === 0 && body.results === undefined) return rows;
    if (!Array.isArray(body?.results)) throw new Error('Federal Register response did not contain document results');
    rows.push(...body.results);
    if (!body.next_page_url) return rows;
  }
  throw new Error(`Federal Register document search exceeded ${MAX_PAGES} pages`);
}

export async function fetchFederalRegister({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const through = PUBLICATION_DAY.format(nowMs);
  const from = new Date(Date.parse(through) - 29 * DAY_MS).toISOString().slice(0, 10);
  const common = new URLSearchParams({ 'conditions[publication_date][gte]': from, 'conditions[publication_date][lte]': through, per_page: String(PAGE_SIZE), order: 'newest' });
  for (const field of FIELDS) common.append('fields[]', field);
  const presidential = new URLSearchParams(common);
  presidential.append('conditions[type][]', 'PRESDOCU');
  const regulatory = new URLSearchParams(common);
  for (const type of AGENCY_TYPES) regulatory.append('conditions[type][]', type);
  for (const agency of AGENCIES) regulatory.append('conditions[agencies][]', agency);
  const groups = await Promise.all([fetchDocuments(fetchImpl, presidential), fetchDocuments(fetchImpl, regulatory)]);
  return { asOf: nowMs, items: mapFederalRegisterDocuments(groups.flat(), from, through) };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  loadEnvFile(import.meta.url);
  await runSeed('policy', 'federal-register', KEY, fetchFederalRegister, {
    ttlSeconds: TTL_SECONDS,
    validateFn: (value) => Number.isFinite(value?.asOf) && Array.isArray(value.items),
    recordCount: (value) => value.items.length,
    sourceVersion: 'federal-register-v1-30d',
    maxStaleMin: MAX_STALE_MIN,
  });
}
