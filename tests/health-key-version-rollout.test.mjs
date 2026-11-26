import { __testing__ } from '../api/health.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';


const {
  KEY_VERSION_ROLLOUT_DEADLINE_PREFIX,
  writerKeyVersionBehind,
  keyVersionRolloutCommands,
  keyVersionRolloutDurationMs,
  KEY_VERSION_ROLLOUT_MAX_MS,
} = __testing__;

const NAME = 'syntheticSignal';
const KEY = 'signals:daily:v12:US';
const DEADLINE_KEY = KEY_VERSION_ROLLOUT_DEADLINE_PREFIX + KEY;
const NOW = Date.parse('2026-10-08T09:12:00Z');
const BUDGET_MS = 3600_000;

test('a writer that names an older version of the read key is behind', () => {
  assert.equal(writerKeyVersionBehind('signals:daily:v12:US', 'producer:signals:daily:v11:wps-v3'), true);
  assert.equal(writerKeyVersionBehind('signals:daily:v12:US', 'producer:signals:daily:v12:wps-v3'), false);
  assert.equal(writerKeyVersionBehind('signals:daily:v12:US', 'producer:signals:daily:v13:wps-v3'), false);
  assert.equal(writerKeyVersionBehind('signals:daily:v12:US', 'xsignals:daily:v11'), false, 'family must match whole segments');
  assert.equal(writerKeyVersionBehind('signals:daily:v12:US', 'signals:archive:v11'), false);
  assert.equal(writerKeyVersionBehind('signals:daily:v12:US', null), false);
  assert.equal(writerKeyVersionBehind('market:quotes', 'market:quotes:v1'), false, 'unversioned keys never qualify');
});

test('only production claims a deadline, once, and it never expires', () => {
  const candidates = [{ name: NAME, dataKey: KEY, durationMs: BUDGET_MS }];
  assert.deepEqual(keyVersionRolloutCommands(candidates, NOW, 'production'), [
    ['SET', DEADLINE_KEY, String(NOW + BUDGET_MS), 'NX'],
    ['GET', DEADLINE_KEY],
  ]);
  assert.deepEqual(keyVersionRolloutCommands(candidates, NOW, 'preview'), []);
  assert.deepEqual(keyVersionRolloutCommands([], NOW, 'production'), []);
});

test('the window is the staleness budget, capped at one day', () => {
  assert.equal(KEY_VERSION_ROLLOUT_MAX_MS, 24 * 60 * 60 * 1_000);
  assert.equal(keyVersionRolloutDurationMs({ maxStaleMin: 60 }), BUDGET_MS);
  assert.equal(keyVersionRolloutDurationMs({ maxStaleMin: 576000 }), KEY_VERSION_ROLLOUT_MAX_MS);
});
