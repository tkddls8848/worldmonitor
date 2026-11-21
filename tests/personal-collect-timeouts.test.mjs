import test from 'node:test';
import assert from 'node:assert/strict';
import { collectorTimeoutMs } from '../scripts/personal-collect.mjs';

const MIN = 60_000;

test('personal collectors get enough wall time for their configured fetch budgets', () => {
  assert.equal(collectorTimeoutMs('supply-chain-trade'), 20 * MIN);
  assert.equal(collectorTimeoutMs('comtrade-bilateral-hs4'), 15 * MIN);
  assert.equal(collectorTimeoutMs('conflict-intel'), 6 * MIN);
  assert.equal(collectorTimeoutMs('bundle-relay-backup'), 30 * MIN);
});
