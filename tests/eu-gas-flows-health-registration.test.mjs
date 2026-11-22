import { test } from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../api/health.js';

test('EU gas flows is registered as on-demand data with a two-day seed freshness budget', () => {
  const { BOOTSTRAP_KEYS, SEED_META, ON_DEMAND_KEYS } = __testing__;
  assert.equal(BOOTSTRAP_KEYS.euGasFlows, 'energy:eu-gas-flows:v1');
  assert.deepEqual(SEED_META.euGasFlows, { key: 'seed-meta:energy:eu-gas-flows', maxStaleMin: 2880 });
  assert.ok(ON_DEMAND_KEYS.has('euGasFlows'));
});
