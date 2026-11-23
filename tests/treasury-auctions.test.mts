import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { BOOTSTRAP_CACHE_KEYS, bootstrapTierKeyNames } from '../api/_bootstrap-tier-keys.js';
import { __testing__ as health } from '../api/health.js';
import { EXCLUDED_BOOTSTRAP_KEYS } from '../scripts/_widget-data-policy.cjs';
import { DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN } from '../scripts/personal-collect.mjs';
import { buildTreasuryAuctions, fetchTreasuryAuctions } from '../scripts/seed-treasury-auctions.mjs';
import { compareAuctionDemand } from '../shared/treasury-auction-demand.mjs';
import { loadTreasuryAuctions, treasuryResultsUrl } from '../src/services/treasury-auctions.ts';
import { buildSupplementalTickerItems } from '../src/services/world-ticker.ts';

// Projected rows and calendar entries captured from all four Treasury feeds on 2026-11-24.
const fixture = JSON.parse(readFileSync(new URL('./fixtures/treasury-auctions.json', import.meta.url), 'utf8'));
const nowMs = Date.parse('2026-11-24T12:00:00Z');

test('normalizes Fiscal Data results and merges announced and tentative auctions', () => {
  const overlap = fixture.updated.find((row: { cusip: string }) => row.cusip === '91282CRX1');
  const legacy = [...fixture.legacy, {
    ...fixture.legacy[0], cusip: overlap.cusip, auction_date: overlap.comp_auction_close_date, bid_to_cover_ratio: '99',
  }];
  const result = buildTreasuryAuctions({ ...fixture, legacy, nowMs });
  const tens = result.coupons.filter((row) => row.cusip === '91282CRX1');
  assert.equal(tens.length, 1);
  assert.equal(tens[0].bidToCover, 2.46);
  assert.equal(tens[0].verdict, 'weak');
  assert.equal(tens[0].at, Date.parse('2026-11-10T18:00:00Z'));
  assert.ok(Math.abs(tens[0].dealerSharePct - 9.77195) < 0.00001);
  assert.ok(Math.abs(tens[0].indirectSharePct - 61.22734) < 0.00001);
  assert.equal(result.coupons.find((row) => row.cusip === '91282CRE3')?.term, '10-Year');
  assert.ok(result.coupons.some((row) => row.kind === 'tips' && row.term === '30-Year'));
  assert.ok(!result.coupons.some((row) => row.date >= '2026-11-24' || row.kind === 'bill'));
  const bill = result.bills.find((row) => row.kind === 'bill' && row.term === '13-Week');
  assert.ok(bill && bill.count > 0);
  assert.deepEqual(bill.latest, { date: '2026-11-23', discountRatePct: 4.18 });
  assert.ok(result.upcoming.some((row) => row.kind === 'frn' && row.term === '2-Year' && row.status === 'announced'));
  assert.equal(result.upcoming.filter((row) => row.kind === 'note' && row.term === '5-Year' && row.date === '2026-11-24').length, 1);
  assert.ok(!result.upcoming.some((row) => row.date === '2026-12-10'));
  assert.deepEqual(result.nextBenchmarks.map(({ date, term, status }) => [date, term, status]), [
    ['2026-12-08', '10-Year', 'tentative'], ['2026-12-10', '30-Year', 'tentative'],
  ]);
  const afterClose = buildTreasuryAuctions({ ...fixture, nowMs: Date.parse('2026-11-24T18:01:00Z') });
  assert.ok(!afterClose.upcoming.some((row) => row.date === '2026-11-24' && row.kind === 'frn'));
});

test('uses only the preceding six auctions, requires material moves, and suppresses conflicting signals', () => {
  const normal = { bidToCover: 2.5, dealerSharePct: 12, indirectSharePct: 60 };
  const previous = [{ ...normal, bidToCover: 100 }, ...Array(6).fill(normal)];
  assert.deepEqual(compareAuctionDemand({ ...normal, bidToCover: 2.4 }, previous), {
    verdict: 'weak', trailing: normal,
  });
  assert.equal(compareAuctionDemand({ ...normal, dealerSharePct: 9 }, previous).verdict, 'strong');
  assert.equal(compareAuctionDemand({ ...normal, bidToCover: 2.4, dealerSharePct: 9 }, previous).verdict, 'neutral');
  assert.equal(compareAuctionDemand({ ...normal, bidToCover: 2.48, dealerSharePct: 13.9 }, previous).verdict, 'neutral');
  assert.equal(compareAuctionDemand({ ...normal, dealerSharePct: null }, previous).verdict, 'insufficient');
  assert.equal(compareAuctionDemand(normal, previous.slice(-5)).verdict, 'insufficient');
  const variable = [2, 2, 2, 3, 3, 3].map((bidToCover) => ({ ...normal, bidToCover }));
  assert.equal(compareAuctionDemand({ ...normal, bidToCover: 2 }, variable).verdict, 'neutral');
  assert.equal(compareAuctionDemand({ ...normal, bidToCover: 1.9 }, variable).verdict, 'weak');
});

test('uses fixed sources and a User-Agent, reads a second page, and rejects an incomplete calendar', async () => {
  const calls: string[] = [];
  const fetchImpl = async (source: string | URL, init: RequestInit) => {
    const url = new URL(source);
    assert.ok(new Headers(init.headers).get('user-agent'));
    assert.equal(init.redirect, 'error');
    const page = url.searchParams.get('page[number]');
    calls.push(`${url.pathname}:${page}`);
    if (url.hostname === 'home.treasury.gov') return new Response(fixture.tentative);
    if (url.hostname === 'www.treasurydirect.gov') return Response.json(fixture.announced);
    assert.equal(url.hostname, 'api.fiscaldata.treasury.gov');
    assert.match(url.searchParams.get('filter') ?? '', /:lte:2026-11-24$/);
    if (url.pathname.endsWith('/auctions_query')) return Response.json({ data: fixture.legacy, meta: { 'total-pages': 1 } });
    assert.ok(url.pathname.endsWith('/treasury_securities_auctions_v2'));
    return Response.json({ data: page === '1' ? fixture.updated.slice(0, 8) : fixture.updated.slice(8), meta: { 'total-pages': 2 } });
  };
  assert.deepEqual(await fetchTreasuryAuctions({ nowMs, fetchImpl }), buildTreasuryAuctions({ ...fixture, nowMs }));
  assert.equal(calls.length, 5);
  await assert.rejects(fetchTreasuryAuctions({ nowMs, fetchImpl: async () => new Response(null, { status: 503 }) }), /HTTP 503/);
  assert.throws(() => buildTreasuryAuctions({ ...fixture, tentative: '<AuctionCalendar/>', nowMs }), /calendar is missing/);
});

test('registers hourly collection, health and on-demand hydration, and builds source-linked ticker items', async (t) => {
  assert.ok(DEFAULT_COLLECTORS.includes('treasury-auctions'));
  assert.equal(STANDALONE_INTERVAL_MIN['treasury-auctions'], 60);
  assert.ok(bootstrapTierKeyNames('on-demand').includes('treasuryAuctions'));
  assert.ok(Object.hasOwn(EXCLUDED_BOOTSTRAP_KEYS, 'treasuryAuctions'));
  assert.equal(health.STANDALONE_KEYS.treasuryAuctions, BOOTSTRAP_CACHE_KEYS.treasuryAuctions);
  assert.equal(health.SEED_META.treasuryAuctions.key, 'seed-meta:markets:treasury-auctions');
  assert.equal(health.SEED_META.treasuryAuctions.maxStaleMin, 180);
  assert.equal(health.ACTIVATION_MARKERS.treasuryAuctions, 'seed-activated:markets:treasury-auctions');
  assert.ok(health.ON_DEMAND_KEYS.has('treasuryAuctions'));

  const raw = buildTreasuryAuctions({ ...fixture, nowMs });
  const fetch = t.mock.method(globalThis, 'fetch');
  fetch.mock.mockImplementationOnce(async () => Response.json({ data: { treasuryAuctions: {
    ...raw, coupons: [...raw.coupons, null, { ...raw.coupons[0], date: 'invalid' }],
    nextBenchmarks: [...raw.nextBenchmarks, { ...raw.nextBenchmarks[0], kind: 'tips' }],
  } } }));
  fetch.mock.mockImplementationOnce(async () => Response.json({ data: {} }), 1);
  const treasuryAuctions = await loadTreasuryAuctions();
  assert.match(String(fetch.mock.calls[0]?.arguments[0]), /\/api\/bootstrap\?keys=treasuryAuctions&public=1$/);
  assert.deepEqual(treasuryAuctions, { coupons: raw.coupons, nextBenchmarks: raw.nextBenchmarks });
  const [latest, next] = buildSupplementalTickerItems({ treasuryAuctions });
  assert.equal(latest?.value, 2.36);
  assert.match(latest?.url ?? '', /R_20261112_4\.pdf$/);
  assert.equal(next?.displayValue, '12-08 ET');
  assert.match(next?.url ?? '', /Tentative-Auction-Schedule\.pdf$/);
  assert.match(treasuryResultsUrl('../../unsafe.pdf'), /\/datasets\//);
  assert.equal(await loadTreasuryAuctions(), null);
});
