import assert from 'node:assert/strict';
import { test } from 'node:test';
import { __testing__ } from '../api/health.js';

const ROWS = [['worldRelations', 'world-overview:relations:v1', 'seed-meta:world-overview:relations', 4320]];

test('registers world overview probes as on-demand standalone keys with activation markers', () => {
  for (const [name, key, meta, minutes] of ROWS) {
    const activationKey = `seed-activated:${key.replace(/:v1$/, '')}`;
    assert.equal(__testing__.STANDALONE_KEYS[name], key);
    assert.deepEqual(__testing__.SEED_META[name], { key: meta, maxStaleMin: minutes, activationKey,
      cutover: { mode: 'activation-marker', fromKey: null, issue: 9, activationKey } });
    assert.equal(__testing__.ACTIVATION_MARKERS[name], activationKey);
  }
});

test('stays pending before first publish and reports stale data after maxStaleMin', () => {
  const now = Date.parse('2026-11-22T00:00:00Z');
  const classify = (present, active, ageMinutes = 1) => __testing__.classifyKey('worldRelations',
    __testing__.STANDALONE_KEYS.worldRelations, { allowOnDemand: true }, {
      keyStrens: new Map(present ? [[__testing__.STANDALONE_KEYS.worldRelations, 100]] : []),
      keyErrors: new Map(), keyMetaErrors: new Map(), now,
      activationStates: new Map([['worldRelations', active]]),
      keyMetaValues: new Map(present ? [[__testing__.SEED_META.worldRelations.key, JSON.stringify({ fetchedAt: now - ageMinutes * 60_000, recordCount: 10, status: 'ok' })]] : []),
    });
  assert.equal(classify(false, false).status, 'EMPTY_ON_DEMAND');
  assert.equal(classify(false, true).status, 'EMPTY');
  assert.equal(classify(true, true).status, 'OK');
  assert.equal(classify(true, true, 4321).status, 'STALE_SEED');
});
