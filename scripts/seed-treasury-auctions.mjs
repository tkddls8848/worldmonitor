#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { XMLParser } from 'fast-xml-parser';
import { BOOTSTRAP_CACHE_KEYS } from '../shared/bootstrap-tier-keys.js';
import { compareAuctionDemand } from '../shared/treasury-auction-demand.mjs';
import { getRedisCredentials, loadEnvFile, redisCommand, runSeed } from './_seed-utils.mjs';

const FISCAL_API = 'https://api.fiscaldata.treasury.gov/services/api/fiscal_service/v1/accounting/od/';
const ANNOUNCED = 'https://www.treasurydirect.gov/TA_WS/securities/upcoming?format=json';
const TENTATIVE = 'https://home.treasury.gov/system/files/221/Tentative-Auction-Schedule.xml';
const ACTIVATION_KEY = 'seed-activated:markets:treasury-auctions';
const DAY_MS = 86_400_000;
const ET = 'America/New_York';
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: ET, year: 'numeric', month: '2-digit', day: '2-digit' });
const ET_OFFSET = new Intl.DateTimeFormat('en-US', { timeZone: ET, timeZoneName: 'shortOffset' });
const SHARED_FIELDS = ['cusip', 'security_type', 'security_term', 'original_security_term', 'issue_date',
  'offering_amt', 'bid_to_cover_ratio', 'floating_rate', 'high_yield', 'high_discnt_margin', 'pdf_filenm_comp_results'];
const UPDATED_FIELDS = [...SHARED_FIELDS, 'comp_auction_close_date', 'comp_auction_close_time', 'inflation_protected',
  'cash_management_bill', 'total_par_inside_awarded', 'subtot_comp_inside_awrd', 'subtot_noncomp_inside_awrd', 'high_rate',
  'prim_deal_comp_par_awarded', 'dir_bid_comp_par_awarded', 'indir_bid_comp_par_awarded'];
const LEGACY_FIELDS = [...SHARED_FIELDS, 'auction_date', 'closing_time_comp', 'inflation_index_security',
  'cash_management_bill_cmb', 'total_accepted', 'comp_accepted', 'high_discnt_rate',
  'primary_dealer_accepted', 'direct_bidder_accepted', 'indirect_bidder_accepted'];

function day(value) {
  const date = typeof value === 'string' ? value.slice(0, 10) : '';
  const at = Date.parse(date);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(at) && new Date(at).toISOString().startsWith(date) ? date : null;
}

function addDays(date, days) {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function number(value) {
  const parsed = typeof value === 'number' || (typeof value === 'string' && value.trim()) ? Number(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function yes(value) { return value === 'Yes' || value === 'Y'; }

function auctionKind(type, tips, frn, cmb) {
  if (tips) return 'tips';
  if (frn) return 'frn';
  if (cmb || type === 'CMB') return 'cmb';
  switch (type) {
    case 'Note': return 'note';
    case 'Bond': return 'bond';
    case 'Bill': return 'bill';
    case 'TIPS': return 'tips';
    case 'FRN': return 'frn';
    default: return null;
  }
}

function auctionTerm(kind, term, originalTerm) {
  const value = ['bill', 'cmb'].includes(kind) || !/^\d+-Year$/.test(originalTerm) ? term : originalTerm;
  return typeof value === 'string' && /^\d+-(?:Year|Month|Week|Day)(?: \d+-(?:Month|Day))?$/.test(value) ? value : null;
}

function closeTime(date, time) {
  const match = /^(\d{1,2}):([0-5]\d) (AM|PM)$/.exec(time);
  const hour = match ? Number(match[1]) : 0;
  if (hour < 1 || hour > 12) return null;
  // Auction hours are after the Eastern DST transition, which occurs before sunrise.
  const offset = Number(ET_OFFSET.formatToParts(Date.parse(`${date}T17:00:00Z`))
    .find((part) => part.type === 'timeZoneName')?.value.replace('GMT', ''));
  return Date.parse(date) + ((hour % 12 + (match[3] === 'PM' ? 12 : 0) - offset) * 60 + Number(match[2])) * 60_000;
}

function share(award, competitive) {
  const value = number(award);
  return value !== null && competitive > 0 && value >= 0 && value <= competitive ? 100 * value / competitive : null;
}

function parseResult(row, updated) {
  if (!row || !/^[A-Z0-9]{9}$/.test(row.cusip)) return null;
  const date = day(updated ? row.comp_auction_close_date : row.auction_date);
  const issueDate = day(row.issue_date);
  const kind = auctionKind(row.security_type, yes(updated ? row.inflation_protected : row.inflation_index_security),
    yes(row.floating_rate), yes(updated ? row.cash_management_bill : row.cash_management_bill_cmb));
  const term = auctionTerm(kind, row.security_term, row.original_security_term);
  const bidToCover = number(row.bid_to_cover_ratio);
  const offeringUsd = number(row.offering_amt);
  const competitive = number(updated ? row.subtot_comp_inside_awrd : row.comp_accepted);
  const noncompetitive = number(row.subtot_noncomp_inside_awrd);
  // The updated table leaves the combined inside-offering total blank on older rows.
  const insideTotal = competitive !== null && noncompetitive !== null ? competitive + noncompetitive : null;
  const acceptedUsd = updated ? number(row.total_par_inside_awarded) ?? insideTotal : number(row.total_accepted);
  if (!date || !issueDate || !kind || !term || !(bidToCover > 0) || !(offeringUsd > 0) || !(acceptedUsd > 0)) return null;
  const bill = kind === 'bill' || kind === 'cmb';
  const at = closeTime(date, updated ? row.comp_auction_close_time : row.closing_time_comp)
    ?? closeTime(date, bill ? '11:30 AM' : '01:00 PM');
  if (!Number.isFinite(at)) return null;
  const highRatePct = number(bill ? (updated ? row.high_rate : row.high_discnt_rate)
    : kind === 'frn' ? row.high_discnt_margin : row.high_yield);
  return {
    cusip: row.cusip, kind, term, date, issueDate, at, offeringUsd, acceptedUsd, highRatePct, bidToCover,
    dealerSharePct: share(updated ? row.prim_deal_comp_par_awarded : row.primary_dealer_accepted, competitive),
    directSharePct: share(updated ? row.dir_bid_comp_par_awarded : row.direct_bidder_accepted, competitive),
    indirectSharePct: share(updated ? row.indir_bid_comp_par_awarded : row.indirect_bidder_accepted, competitive),
    resultsFile: /^R_\d{8}_\d+\.pdf$/.test(row.pdf_filenm_comp_results) ? row.pdf_filenm_comp_results : null,
  };
}

function isBill(auction) { return auction.kind === 'bill' || auction.kind === 'cmb'; }
function isBenchmark({ kind, term }) { return (kind === 'note' && term === '10-Year') || (kind === 'bond' && term === '30-Year'); }
function series({ kind, term }) { return `${kind}:${term}`; }
function calendarKey(auction) { return `${auction.date}:${series(auction)}`; }

function parseCalendar(announced, xml, today, results, nowMs) {
  const planned = new XMLParser({ processEntities: false, parseTagValue: false }).parse(xml)?.AuctionCalendar;
  const rows = planned?.AuctionCalendarDate;
  const through = day(planned?.EndDate);
  if (!Array.isArray(announced) || !Array.isArray(rows) || !through || through < addDays(today, 14)) {
    throw new Error('Treasury auction calendar is missing or does not cover the next 14 days');
  }
  const resultKeys = new Set(results.map(calendarKey));
  const calendar = new Map();
  for (const row of rows) {
    const kind = auctionKind({ NOTE: 'Note', BOND: 'Bond', BILL: 'Bill' }[row.SecurityType], yes(row.TIPS), yes(row.FloatingRate));
    const date = day(row.AuctionDate);
    const issueDate = day(row.SettlementDate);
    const term = auctionTerm(kind, row.SecurityTermWeekYear);
    if (!kind || !date || date < today || !issueDate || !term) continue;
    const auction = { date, issueDate, kind, term, status: 'tentative', offeringUsd: null };
    calendar.set(calendarKey(auction), auction);
  }
  for (const row of announced) {
    const kind = auctionKind(row?.type);
    const term = auctionTerm(kind, row?.securityTerm, row?.originalSecurityTerm);
    const date = day(row?.competitiveAuctionCloseDate);
    const issueDate = day(row?.issueDate);
    if (!kind || !date || date < today || !issueDate || !term) continue;
    const at = closeTime(date, row.competitiveAuctionCloseTime);
    const offeringUsd = number(row.offeringAmount);
    if (!(offeringUsd > 0)) continue; // This feed also lists auctions before the offering is announced.
    const auction = { date, issueDate, kind, term, offeringUsd, status: 'announced' };
    const key = calendarKey(auction);
    if (at !== null && at <= nowMs) calendar.delete(key);
    else calendar.set(key, auction);
  }
  return [...calendar.values()].filter((auction) => !resultKeys.has(calendarKey(auction)))
    .sort((a, b) => a.date.localeCompare(b.date) || series(a).localeCompare(series(b)));
}

export function buildTreasuryAuctions({ updated, legacy, announced, tentative, nowMs }) {
  const today = ET_DAY.format(nowMs);
  const firstDay = addDays(today, -183);
  const results = new Map();
  for (const [rows, isUpdated] of [[legacy, false], [updated, true]]) {
    for (const row of rows) {
      const result = parseResult(row, isUpdated);
      if (result && result.at <= nowMs) results.set(`${result.date}:${result.cusip}`, result);
    }
  }
  const history = new Map();
  const coupons = [];
  const bills = new Map();
  const ordered = [...results.values()].sort((a, b) => a.at - b.at);
  for (const result of ordered) {
    const key = series(result);
    if (isBill(result)) {
      if (result.date < firstDay) continue;
      const summary = bills.get(key) ?? { kind: result.kind, term: result.term, count: 0, offeringUsd: 0, acceptedUsd: 0, meanBidToCover: 0 };
      summary.count += 1;
      summary.offeringUsd += result.offeringUsd;
      summary.acceptedUsd += result.acceptedUsd;
      summary.meanBidToCover += (result.bidToCover - summary.meanBidToCover) / summary.count;
      summary.latest = { date: result.date, discountRatePct: result.highRatePct };
      bills.set(key, summary);
      continue;
    }
    const previous = history.get(key) ?? [];
    if (result.date >= firstDay) coupons.push({ ...result, ...compareAuctionDemand(result, previous) });
    history.set(key, [...previous.slice(-5), result]);
  }
  const calendar = parseCalendar(announced, tentative, today, ordered, nowMs);
  return {
    asOf: nowMs, coupons: coupons.reverse(), bills: [...bills.values()],
    upcoming: calendar.filter((auction) => auction.date <= addDays(today, 14)),
    nextBenchmarks: ['note', 'bond'].flatMap((kind) => calendar.find((auction) => auction.kind === kind && isBenchmark(auction)) ?? [])
      .sort((a, b) => a.date.localeCompare(b.date)),
  };
}

async function fetchSource(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { 'User-Agent': 'WorldMonitor/1.0 (personal dashboard)' },
    redirect: 'error', signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Treasury upstream ${new URL(url).hostname} returned HTTP ${response.status}`);
  return response;
}

async function fetchResults(fetchImpl, endpoint, fields, dateKey, from, through) {
  const url = new URL(endpoint, FISCAL_API);
  url.searchParams.set('fields', fields.join(','));
  url.searchParams.set('filter', `${dateKey}:gte:${from},${dateKey}:lte:${through}`);
  url.searchParams.set('sort', `${dateKey},cusip`);
  url.searchParams.set('page[size]', '1000');
  const rows = [];
  for (let page = 1; page <= 4; page += 1) {
    url.searchParams.set('page[number]', String(page));
    const body = await (await fetchSource(fetchImpl, url)).json();
    if (!Array.isArray(body?.data) || !Number.isInteger(body?.meta?.['total-pages'])) {
      throw new Error(`Invalid Treasury auction results response from ${endpoint}`);
    }
    rows.push(...body.data);
    if (page >= body.meta['total-pages']) return rows;
  }
  throw new Error(`Treasury auction results exceeded four pages for ${endpoint}`);
}

export async function fetchTreasuryAuctions({ fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const today = ET_DAY.format(nowMs);
  // Four years supplies six comparisons even for semiannual 30-year TIPS.
  const from = addDays(today, -4 * 366);
  const [updated, legacy, announced, tentative] = await Promise.all([
    fetchResults(fetchImpl, 'treasury_securities_auctions_v2', UPDATED_FIELDS, 'comp_auction_close_date', from, today),
    fetchResults(fetchImpl, 'auctions_query', LEGACY_FIELDS, 'auction_date', from, today),
    fetchSource(fetchImpl, ANNOUNCED).then((response) => response.json()),
    fetchSource(fetchImpl, TENTATIVE).then((response) => response.text()),
  ]);
  if (!updated.length) throw new Error('Updated Treasury auction results are empty');
  return buildTreasuryAuctions({ updated, legacy, announced, tentative, nowMs });
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  loadEnvFile(import.meta.url);
  await runSeed('markets', 'treasury-auctions', BOOTSTRAP_CACHE_KEYS.treasuryAuctions, fetchTreasuryAuctions, {
    ttlSeconds: 86_400,
    maxStaleMin: 180,
    sourceVersion: 'treasury-auctions-v1',
    validateFn: (value) => value?.coupons.length > 0 && value.bills.length > 0,
    recordCount: (value) => value.coupons.length + value.bills.reduce((sum, bill) => sum + bill.count, 0),
    afterPublish: async () => {
      const { url, token } = getRedisCredentials();
      await redisCommand(url, token, ['SET', ACTIVATION_KEY, '1', 'NX']);
    },
  });
}
