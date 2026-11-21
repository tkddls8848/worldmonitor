import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing__ } from '../api/health.js';

test('world pair trends are registered as a standalone on-demand seed', () => {
  assert.equal(__testing__.STANDALONE_KEYS.worldPairTrends, 'gdelt:bulk:world-pair-trends:v1');
  assert.equal(__testing__.SEED_META.worldPairTrends.key, 'seed-meta:gdelt:bulk:world-pair-trends');
  assert.equal(__testing__.SEED_META.worldPairTrends.maxStaleMin, 240);
  assert.equal(__testing__.ON_DEMAND_KEYS.has('worldPairTrends'), true);
  assert.equal(__testing__.ACTIVATION_MARKERS.worldPairTrends, 'seed-activated:gdelt:bulk:world-pair-trends');
});
