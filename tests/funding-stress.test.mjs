import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { collectFundingStress, parseOfrCsv, parseRateRows, parseRrp } from '../scripts/_funding-stress.mjs';
import { loadFundingStress } from '../src/services/funding-stress.ts';
import { __testing__ as health } from '../api/health.js';
import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../shared/bootstrap-tier-keys.js';

describe('funding stress parsers', () => {
  it('registers the data key for on-demand hydration and daily-source health', () => {
    assert.equal(BOOTSTRAP_CACHE_KEYS.fundingStress, 'markets:funding-stress:v1');
    assert.equal(BOOTSTRAP_TIERS.fundingStress, 'on-demand');
    assert.equal(health.BOOTSTRAP_KEYS.fundingStress, 'markets:funding-stress:v1');
    assert.equal(health.SEED_META.fundingStress.key, 'seed-meta:markets:funding-stress');
    assert.equal(health.SEED_META.fundingStress.maxStaleMin, 2880);
    assert.equal(health.ON_DEMAND_KEYS.has('fundingStress'), true);
  });
  it('returns null when the hydration cache has no funding data', async () => {
    assert.equal(await loadFundingStress(), null);
  });
  it('parses SOFR and EFFR changes in basis points', () => {
    const rows = { refRates: [
      { type: 'SOFR', effectiveDate: '2026-11-19', percentRate: 3.91, percentPercentile1: 3.85, volumeInBillions: 3161 },
      { type: 'SOFR', effectiveDate: '2026-11-18', percentRate: 3.90 },
    ] };
    assert.deepEqual(parseRateRows(rows, 'SOFR'), { rate: 3.91, changeBp: 1, date: '2026-11-19' });
    assert.equal(parseRateRows(rows, 'EFFR'), null);
  });

  it('parses reverse repo accepted amount and daily change', () => {
    assert.deepEqual(parseRrp({ repo: { operations: [
      { operationDate: '2026-11-20', totalAmtAccepted: 401000000 },
      { operationDate: '2026-11-19', totalAmtAccepted: 405000000 },
    ] } }), { amountBn: 0.401, change1dBn: -0.004, date: '2026-11-20' });
  });

  it('parses OFR CSV category components and daily change', () => {
    const csv = 'Date,OFR FSI,Credit,Equity valuation,Safe assets,Funding,Volatility\n2026-11-20,0.25,0.1,0.02,0.03,0.04,0.06\n2026-11-19,0.2,0.08,0.01,0.02,0.03,0.06';
    assert.deepEqual(parseOfrCsv(csv), { value: 0.25, change1d: 0.05, date: '2026-11-20', components: { Credit: 0.1, 'Equity valuation': 0.02, Funding: 0.04, 'Safe assets': 0.03, Volatility: 0.06 } });
  });

  it('publishes successful sources while isolating failed sources', async () => {
    const payload = { refRates: [{ type: 'SOFR', effectiveDate: '2026-11-20', percentRate: 3.9 }] };
    const result = await collectFundingStress(async (url) => {
      if (url.includes('/sofr/')) return { ok: true, json: async () => payload };
      throw new Error('fixture source failure');
    });
    assert.equal(result.sofr.rate, 3.9);
    assert.equal(result.effr, null);
    assert.equal(result.rrp, null);
    assert.equal(result.ofrFsi, null);
  });
});
