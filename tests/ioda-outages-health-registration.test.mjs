import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing__ } from '../api/health.js';

test('IODA outage seed is registered as a fresh on-demand bootstrap key', () => {
  assert.equal(__testing__.BOOTSTRAP_KEYS.iodaOutages, 'infra:ioda-outages:v1');
  assert.equal(__testing__.SEED_META.iodaOutages.key, 'seed-meta:infra:ioda-outages');
  assert.equal(__testing__.SEED_META.iodaOutages.maxStaleMin, 120);
  assert.equal(__testing__.ON_DEMAND_KEYS.has('iodaOutages'), true);
});
