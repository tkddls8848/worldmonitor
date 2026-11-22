import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTickerItems } from '../src/services/world-ticker.ts';

test('returns the eight market instruments in stable display order and keeps missing values', () => {
  const items = buildTickerItems({
    marketQuotes: { quotes: [{ symbol: '^TNX', price: 4.2, change: 0.1 }, { symbol: '^GSPC', price: 6000, change: 1 }, { symbol: '^IXIC', price: 19000, change: -1 }, { symbol: '^KS11', price: 2500, change: 0 }, { symbol: 'KRW=X', price: 1400, change: 0 }] },
    commodityQuotes: { quotes: [{ symbol: 'CL=F', price: 70, change: -2 }, { symbol: 'GC=F', price: 2700, change: 1 }] },
    cryptoQuotes: { quotes: [{ symbol: 'BTC-USD', price: 90000, change: 2 }] },
  });
  assert.deepEqual(items.map((item) => item.id), ['^TNX', '^GSPC', '^IXIC', '^KS11', 'CL=F', 'GC=F', 'KRW=X', 'BTC-USD']);
  assert.deepEqual(items.map((item) => item.value), [4.2, 6000, 19000, 2500, 70, 2700, 1400, 90000]);
  const stress = buildTickerItems({}, {
    fundingStress: { ofrFsi: { value: 0.42, change1d: 0.13 }, sofr: { rate: 4.3, changeBp: 2 } } as never,
    gasFlows: { origins: { russia: { gwhPerDay: 100, change7dPct: -2 }, norway: { gwhPerDay: 200, change7dPct: 1 }, lng: { gwhPerDay: 300, change7dPct: 3 } } },
  });
  assert.deepEqual(stress.slice(8, 10).map(({ label, value, changePct, changeKind, inverse }) => ({ label, value, changePct, changeKind, inverse })), [
    { label: 'OFR 스트레스', value: 0.42, changePct: 0.13, changeKind: 'abs', inverse: true },
    { label: 'SOFR', value: 4.3, changePct: 2, changeKind: 'bp', inverse: undefined },
  ]);
  assert.deepEqual(stress.slice(10).map((item) => [item.label, item.value, item.changePct]), [
    ['EU 가스(러)', 100, -2], ['EU 가스(노)', 200, 1], ['LNG', 300, 3],
  ]);
  assert.equal(buildTickerItems({})[0].value, null);
});
