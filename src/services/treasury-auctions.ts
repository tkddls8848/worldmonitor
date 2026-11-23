import { ensureHydrated } from '@/services/bootstrap';

const COUPON_KINDS = ['note', 'bond', 'tips', 'frn'] as const;
const VERDICTS = ['weak', 'strong', 'neutral', 'insufficient'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TERM = /^\d+-(?:Year|Month|Week|Day)(?: \d+-(?:Month|Day))?$/;
type CouponKind = (typeof COUPON_KINDS)[number];
type Verdict = (typeof VERDICTS)[number];

export interface TreasuryCoupon {
  cusip: string;
  kind: CouponKind;
  term: string;
  date: string;
  at: number;
  bidToCover: number;
  dealerSharePct: number | null;
  indirectSharePct: number | null;
  highRatePct: number | null;
  resultsFile: string | null;
  verdict: Verdict;
}

export interface TreasuryBenchmark {
  kind: 'note' | 'bond';
  term: string;
  date: string;
  status: 'announced' | 'tentative';
}

export interface TreasuryAuctions {
  coupons: TreasuryCoupon[];
  nextBenchmarks: TreasuryBenchmark[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value));
}

function isCoupon(row: unknown): row is TreasuryCoupon {
  return isRecord(row) && typeof row.cusip === 'string' && /^[A-Z0-9]{9}$/.test(row.cusip)
    && COUPON_KINDS.some((kind) => kind === row.kind) && VERDICTS.some((verdict) => verdict === row.verdict)
    && typeof row.term === 'string' && TERM.test(row.term) && typeof row.date === 'string' && DATE.test(row.date)
    && typeof row.at === 'number' && Number.isFinite(new Date(row.at).getTime())
    && typeof row.bidToCover === 'number' && Number.isFinite(row.bidToCover) && row.bidToCover > 0
    && nullableNumber(row.dealerSharePct) && nullableNumber(row.indirectSharePct) && nullableNumber(row.highRatePct)
    && (row.resultsFile === null || typeof row.resultsFile === 'string');
}

export function isTreasuryBenchmark({ kind, term }: { kind: string; term: string }): boolean {
  return (kind === 'note' && term === '10-Year') || (kind === 'bond' && term === '30-Year');
}

function isScheduledBenchmark(row: unknown): row is TreasuryBenchmark {
  return isRecord(row) && typeof row.date === 'string' && DATE.test(row.date)
    && typeof row.kind === 'string' && typeof row.term === 'string' && isTreasuryBenchmark({ kind: row.kind, term: row.term })
    && (row.status === 'announced' || row.status === 'tentative');
}

export async function loadTreasuryAuctions(): Promise<TreasuryAuctions | null> {
  const raw: unknown = await ensureHydrated('treasuryAuctions');
  if (!isRecord(raw) || !Array.isArray(raw.coupons) || !Array.isArray(raw.nextBenchmarks)) return null;
  return { coupons: raw.coupons.filter(isCoupon), nextBenchmarks: raw.nextBenchmarks.filter(isScheduledBenchmark) };
}

export function treasuryAuctionTitle(auction: { term: string; kind: CouponKind }, language: string): string {
  const ko = language === 'ko';
  const term = ko ? auction.term.replace('-Year', '년').replace('-Month', '개월') : auction.term;
  const security = auction.kind === 'tips' ? ' TIPS' : auction.kind === 'frn' ? ' FRN' : '';
  return ko ? `미 국채 ${term}${security} 입찰` : `US Treasury ${term}${security} auction`;
}

export function treasuryDemandLabel(verdict: Verdict, language: string): string {
  return language === 'ko'
    ? { weak: '수요 약세', strong: '수요 강세', neutral: '보통', insufficient: '비교 자료 부족' }[verdict]
    : { weak: 'Weak demand', strong: 'Strong demand', neutral: 'Neutral', insufficient: 'Insufficient history' }[verdict];
}

export function treasuryResultsUrl(file: string | null): string {
  return file && /^R_\d{8}_\d+\.pdf$/.test(file)
    ? `https://fiscaldata.treasury.gov/static-data/published-reports/auctions-query/results/${file}`
    : 'https://fiscaldata.treasury.gov/datasets/treasury-securities-auctions-data/';
}

export function treasuryCalendarUrl(status: TreasuryBenchmark['status']): string {
  return status === 'tentative' ? 'https://home.treasury.gov/system/files/221/Tentative-Auction-Schedule.pdf'
    : 'https://www.treasurydirect.gov/auctions/upcoming/';
}
