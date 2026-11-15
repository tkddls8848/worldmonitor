import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScenarioRuns, diffKeySets, diffTestRuns } from '../scripts/local/baseline/diff.mjs';

test('diffScenarioRuns ignores computedAt', () => {
  const a = [{ computedAt: 1, records: [{ impactPct: 40 }] }];
  const b = [{ computedAt: 2, records: [{ impactPct: 40 }] }];
  assert.deepEqual(diffScenarioRuns(a, b), []);
});

test('diffScenarioRuns reports a changed impact', () => {
  const a = [{ computedAt: 1, records: [{ impactPct: 40 }] }];
  const b = [{ computedAt: 1, records: [{ impactPct: 41 }] }];
  const out = diffScenarioRuns(a, b);
  assert.equal(out.length, 1);
  assert.match(out[0], /impactPct/);
});

test('diffKeySets', () => {
  assert.deepEqual(diffKeySets(['a', 'b'], ['a', 'c']), { removed: ['b'], added: ['c'] });
});

test('diffTestRuns', () => {
  const r = diffTestRuns({ x: 'pass', y: 'fail' }, { x: 'fail', y: 'fail', z: 'fail' });
  assert.deepEqual(r.newlyFailing, ['x', 'z']);
  assert.deepEqual(r.removedFiles, []);
});
