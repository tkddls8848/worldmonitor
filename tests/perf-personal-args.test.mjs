import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../scripts/perf-personal.mjs';

describe('perf-personal parseArgs', () => {
  it('defaults to 5 runs and cpu 1', () => {
    assert.deepEqual(parseArgs(['--label', 'baseline']), { mode: 'measure', label: 'baseline', runs: 5, cpu: 1 });
  });
  it('reads --runs and --cpu', () => {
    const a = parseArgs(['--label', 'x', '--runs', '3', '--cpu', '4']);
    assert.equal(a.runs, 3);
    assert.equal(a.cpu, 4);
  });
  it('reads --compare', () => {
    const a = parseArgs(['--compare', 'baseline', 'no-globe']);
    assert.equal(a.mode, 'compare');
    assert.deepEqual(a.compare, ['baseline', 'no-globe']);
  });
  it('rejects unsafe labels and empty args', () => {
    assert.throws(() => parseArgs(['--label', '../x']));
    assert.throws(() => parseArgs([]));
  });
});
