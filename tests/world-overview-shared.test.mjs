import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, kstDate, kstHour, pairKey, WORLD_OVERVIEW_KEYS } from '../shared/world-overview.js';

test('KST date changes at 15:00 UTC', () => {
  assert.equal(kstDate(Date.parse('2026-11-22T14:59:59Z')), '2026-11-22');
  assert.equal(kstDate(Date.parse('2026-11-22T15:00:00Z')), '2026-11-23');
  assert.equal(kstHour(Date.parse('2026-11-22T21:00:00Z')), 6);
});
test('addDays crosses months and years', () => {
  assert.equal(addDays('2026-11-22', 13), '2026-12-05');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-11-22', -89), '2026-08-25');
});
test('pairKey is order-independent and keys match the plan', () => {
  assert.equal(pairKey('UA', 'RU'), 'RU:UA');
  assert.equal(WORLD_OVERVIEW_KEYS.relations, 'world-overview:relations:v1');
});
