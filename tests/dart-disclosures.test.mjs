import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ as healthTesting } from '../api/health.js';
import {
  classifyDartStatus, dateRangeKst, mapDartDisclosure, rankDartDisclosures,
  receiptTimeKst,
} from '../scripts/seed-dart-disclosures.mjs';

const row = (overrides = {}) => ({
  rcept_no: '20261122000123', rcept_dt: '20261122', corp_name: 'Example Co',
  stock_code: '005930', corp_cls: 'Y', report_nm: '유상증자 결정', flr_nm: 'Example Co', rm: '',
  ...overrides,
});

describe('OpenDART disclosure mapping', () => {
  it('registers the cache as on-demand with a 180-minute health budget', () => {
    assert.equal(healthTesting.BOOTSTRAP_KEYS.krDartDisclosures, 'kr:dart-disclosures:v1');
    assert.equal(healthTesting.SEED_META.krDartDisclosures.key, 'seed-meta:market:dart-disclosures');
    assert.equal(healthTesting.SEED_META.krDartDisclosures.maxStaleMin, 180);
    assert.ok(healthTesting.ON_DEMAND_KEYS.has('krDartDisclosures'));
  });

  it('maps listed market, kind, viewer URL, nullable stock code and KST receipt midnight', () => {
    const item = mapDartDisclosure(row({ corp_cls: 'K', stock_code: '' }), 'ownership');
    assert.equal(item.market, 'KOSDAQ');
    assert.equal(item.kind, 'ownership');
    assert.equal(item.stockCode, null);
    assert.equal(item.at, Date.parse('2026-11-21T15:00:00Z'));
    assert.match(item.url, /rcpNo=20261122000123$/u);
    assert.equal(mapDartDisclosure(row({ corp_cls: 'N' }), 'major'), null);
  });

  it('uses the last three KST calendar dates', () => {
    assert.deepEqual(dateRangeKst(new Date('2026-11-22T00:10:00Z')), { bgn_de: '20261120', end_de: '20261122' });
    assert.equal(receiptTimeKst('20261122'), Date.parse('2026-11-21T15:00:00Z'));
  });

  it('ranks market, then filing kind, then newest and caps at 80', () => {
    const values = [
      { ...mapDartDisclosure(row({ corp_cls: 'K', rcept_no: 'k' }), 'major') },
      { ...mapDartDisclosure(row({ corp_cls: 'Y', rcept_no: 'd', rcept_dt: '20261120' }), 'ownership') },
      { ...mapDartDisclosure(row({ corp_cls: 'Y', rcept_no: 'b', rcept_dt: '20261120' }), 'major') },
      { ...mapDartDisclosure(row({ corp_cls: 'Y', rcept_no: 'newer' }), 'major') },
      { ...mapDartDisclosure(row({ corp_cls: 'Y', rcept_no: 'i', report_nm: '단일판매·공급계약 체결' }), 'exchange') },
      ...Array.from({ length: 90 }, (_, index) => mapDartDisclosure(row({ corp_cls: 'K', rcept_no: `n${index}` }), 'major')),
      mapDartDisclosure(row({ rcept_no: 'filtered', report_nm: '일반 수시공시' }), 'exchange'),
    ];
    const ranked = rankDartDisclosures(values);
    assert.equal(ranked.length, 80);
    assert.equal(ranked[0].id, 'newer');
    assert.equal(ranked[1].id, 'b');
    assert.equal(ranked[2].id, 'd');
    assert.ok(ranked.some((item) => item.id === 'i'));
    assert.ok(!ranked.some((item) => item.id === 'filtered'));
    assert.ok(ranked.findIndex((item) => item.market === 'KOSDAQ') > 0);
  });

  it('handles documented API statuses', () => {
    assert.equal(classifyDartStatus({ status: '000' }), 'ok');
    assert.equal(classifyDartStatus({ status: '013' }), 'empty');
    for (const status of ['020', '010', '011']) {
      assert.throws(() => classifyDartStatus({ status, message: 'fixture' }), new RegExp(status));
    }
  });
});
