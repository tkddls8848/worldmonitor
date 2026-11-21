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


test('daily AI relations are an activation-marked on-demand health key', () => {
  assert.equal(__testing__.STANDALONE_KEYS.worldRelationsAi, 'world-overview:ai:v1');
  assert.equal(__testing__.SEED_META.worldRelationsAi.key, 'seed-meta:world-overview:ai');
  assert.equal(__testing__.SEED_META.worldRelationsAi.maxStaleMin, 2160);
  assert.equal(__testing__.ACTIVATION_MARKERS.worldRelationsAi, 'seed-activated:world-overview:ai');
  assert.equal(__testing__.ON_DEMAND_KEYS.has('worldRelationsAi'), true);
});
