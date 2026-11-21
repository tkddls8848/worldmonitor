import test from 'node:test';
import assert from 'node:assert/strict';
import { addDays, kstDate, kstHour, relationMatchKey, WORLD_OVERVIEW_KEYS } from '../shared/world-overview.js';

test('KST date changes at 15:00 UTC', () => {
  assert.equal(kstDate(Date.parse('2026-11-22T14:59:59Z')), '2026-11-22');
  assert.equal(kstDate(Date.parse('2026-11-22T15:00:00Z')), '2026-11-23');
  assert.equal(kstHour(Date.parse('2026-11-22T21:00:00Z')), 6);
});
test('date and pair helpers follow the contract', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(WORLD_OVERVIEW_KEYS.ai, 'world-overview:ai:v1');
  assert.equal(relationMatchKey({ kind: 'support', from: 'US', to: 'UA' }), 'support:US>UA');
  assert.equal(relationMatchKey({ kind: 'tension', from: 'US', to: 'CN' }), 'tension:CN-US');
});
