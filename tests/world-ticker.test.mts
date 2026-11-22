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
  assert.equal(buildTickerItems({})[0].value, null);
});
