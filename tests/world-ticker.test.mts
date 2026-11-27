import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTickerItems } from '../src/services/world-ticker.ts';

test('returns the seven market instruments in stable display order and keeps missing values', () => {
  const items = buildTickerItems({
    marketQuotes: { quotes: [{ symbol: '^TNX', price: 4.2, change: 0.1 }, { symbol: '^GSPC', price: 6000, change: 1 }, { symbol: '^IXIC', price: 19000, change: -1 }, { symbol: '^KS11', price: 2500, change: 0 }, { symbol: 'KRW=X', price: 1400, change: 0 }] },
    commodityQuotes: { quotes: [{ symbol: 'CL=F', price: 70, change: -2 }, { symbol: 'GC=F', price: 2700, change: 1 }] },
  });
  assert.deepEqual(items.map((item) => item.id), ['^TNX', '^GSPC', '^IXIC', '^KS11', 'CL=F', 'GC=F', 'KRW=X']);
  assert.deepEqual(items.map((item) => item.value), [4.2, 6000, 19000, 2500, 70, 2700, 1400]);
  const stress = buildTickerItems({}, {
    fundingStress: { ofrFsi: { value: 0.42, change1d: 0.13 }, sofr: { rate: 4.3, changeBp: 2 } } as never,
    gasFlows: { origins: { russia: { gwhPerDay: 100, change7dPct: -2 }, norway: { gwhPerDay: 200, change7dPct: 1 }, lng: { gwhPerDay: 300, change7dPct: 3 } } },
  });
  assert.deepEqual(stress.slice(items.length, items.length + 2).map(({ label, value, changePct, changeKind, inverse }) => ({ label, value, changePct, changeKind, inverse })), [
    { label: 'OFR 스트레스', value: 0.42, changePct: 0.13, changeKind: 'abs', inverse: true },
    { label: 'SOFR', value: 4.3, changePct: 2, changeKind: 'bp', inverse: undefined },
  ]);
  assert.deepEqual(stress.slice(items.length + 2).map((item) => [item.label, item.value, item.changePct]), [
    ['EU 가스(러)', 100, -2], ['EU 가스(노)', 200, 1], ['LNG', 300, 3],
  ]);
  assert.equal(buildTickerItems({})[0].value, null);
});

test('adds Korean 10-year yield and provisional export growth without duplicating USD/KRW', () => {
  const items = buildTickerItems({ marketQuotes: { quotes: [{ symbol: 'KRW=X', price: 1400 }] } }, { korea: {
    ktb10y: { value: 3.4, changeBp: 2.1 },
    trade: { month: '202610', total: { exportYoyPct: 4.2 }, provisional: { period: '11월 1~10일', exportYoyPct: 8.7 } },
  } });
  assert.equal(items.filter((item) => item.id === 'KRW=X').length, 1);
  assert.deepEqual(items.slice(-2).map(({ label, value, changePct, changeKind }) => [label, value, changePct, changeKind]), [
    ['국고채 10년', 3.4, 2.1, 'bp'], ['한국 수출 11월 1~10일', 8.7, null, undefined],
  ]);
});
