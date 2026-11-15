import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffScenarioRuns, diffKeySets, diffTestRuns, countErrors, parseJunit } from '../scripts/local/baseline/diff.mjs';

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

test('countErrors counts matches, and returns null for a silent failure', () => {
  const re = /error TS\d+/;
  assert.equal(countErrors({ exitCode: 0, output: 'ok' }, re), 0);
  assert.equal(countErrors({ exitCode: 2, output: 'a error TS1\nb error TS2' }, re), 2);
  assert.equal(countErrors({ exitCode: 1, output: 'tsc crashed' }, re), null);
});

test('diffTestRuns reports a new failing test inside an already-failing file', () => {
  const base = { 'f.mjs :: a': 'fail', 'f.mjs :: b': 'pass' };
  const after = { 'f.mjs :: a': 'fail', 'f.mjs :: b': 'fail' };
  assert.deepEqual(diffTestRuns(base, after).newlyFailing, ['f.mjs :: b']);
});

test('parseJunit flattens suites, marks failures, and dedupes names', () => {
  const xml = '<testsuites><testsuite name="s" tests="2">' +
    '<testcase name="a" classname="s"/>' +
    '<testcase name="b &amp; c" classname="s"><failure message="x">boom</failure></testcase>' +
    '</testsuite><testcase name="top"/><testcase name="top"/></testsuites>';
  assert.deepEqual(parseJunit(xml), { 's > a': 'pass', 's > b & c': 'fail', top: 'pass', 'top #2': 'pass' });
});
