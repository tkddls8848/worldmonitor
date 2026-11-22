import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing__ } from '../api/health.js';
import { BOOTSTRAP_CACHE_KEYS, BOOTSTRAP_TIERS } from '../shared/bootstrap-tier-keys.js';

test('Korea Customs trade is an on-demand key with a three-day seed health budget', () => {
  assert.equal(BOOTSTRAP_CACHE_KEYS.krCustomsTrade, 'kr:customs-trade:v1');
  assert.equal(BOOTSTRAP_TIERS.krCustomsTrade, 'on-demand');
  assert.equal(__testing__.STANDALONE_KEYS.krCustomsTrade, 'kr:customs-trade:v1');
  assert.deepEqual(__testing__.SEED_META.krCustomsTrade, { key: 'seed-meta:kr-customs-trade:monthly', maxStaleMin: 4320 });
  assert.equal(__testing__.ON_DEMAND_KEYS.has('krCustomsTrade'), true);
});
