import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parseYahooChart } from '../scripts/_seed-utils.mjs';
import { DEFAULT_COLLECTORS, STANDALONE_INTERVAL_MIN } from '../scripts/personal-collect.mjs';
import { fetchShippingStress } from '../scripts/seed-shipping-stress.mjs';

const chart = JSON.parse(readFileSync(new URL('./fixtures/shipping-stress-bdry.json', import.meta.url)));

test('the collector scores the available Yahoo chart and preserves the carrier shape', async () => {
  const result = await fetchShippingStress((symbol) => symbol === 'BDRY' ? parseYahooChart(chart, symbol) : null);
  assert.deepEqual(result.carriers.map(({ symbol, price, changePct }) => ({ symbol, price, changePct })), [
    { symbol: 'BDRY', price: 12.94, changePct: 2.18 },
  ]);
  assert.equal(result.stressScore, 33);
  assert.equal(result.stressLevel, 'moderate');
  assert.ok(result.carriers[0].sparkline.length);
  assert.ok(result.fetchedAt > 0);
});

test('all-missing quotes fail the seed and the collector is due every 15 minutes', async () => {
  await assert.rejects(fetchShippingStress(() => null), /no carrier quotes/);
  assert.ok(DEFAULT_COLLECTORS.includes('shipping-stress'));
  assert.equal(STANDALONE_INTERVAL_MIN['shipping-stress'], 15);
});
