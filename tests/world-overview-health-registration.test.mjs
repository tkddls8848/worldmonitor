import test from 'node:test';
import assert from 'node:assert/strict';
import { __testing__ } from '../api/health.js';

test('daily AI relations are an activation-marked on-demand health key', () => {
  assert.equal(__testing__.STANDALONE_KEYS.worldRelationsAi, 'world-overview:ai:v1');
  assert.equal(__testing__.SEED_META.worldRelationsAi.key, 'seed-meta:world-overview:ai');
  assert.equal(__testing__.SEED_META.worldRelationsAi.maxStaleMin, 2160);
  assert.equal(__testing__.ACTIVATION_MARKERS.worldRelationsAi, 'seed-activated:world-overview:ai');
  assert.equal(__testing__.ON_DEMAND_KEYS.has('worldRelationsAi'), true);
});
