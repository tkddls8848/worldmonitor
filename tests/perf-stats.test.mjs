import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { summarize, isImprovement, compareReports } from '../scripts/perf/perf-stats.mjs';

describe('summarize', () => {
  it('takes the median of the successful samples and counts failures', () => {
    assert.deepEqual(summarize([30, 10, 20, null, 40]), { median: 25, min: 10, max: 40, runs: 5, failed: 1 });
  });
  it('uses the middle value for an odd count', () => {
    assert.deepEqual(summarize([5, 1, 3]), { median: 3, min: 1, max: 5, runs: 3, failed: 0 });
  });
  it('returns null stats when every sample failed', () => {
    assert.deepEqual(summarize([null, null]), { median: null, min: null, max: null, runs: 2, failed: 2 });
  });
});

describe('isImprovement', () => {
  const before = { median: 100, min: 95, max: 105, runs: 5, failed: 0 };
  it('accepts a 10%+ gain larger than the spread', () => {
    assert.equal(isImprovement(before, { median: 85, min: 83, max: 88, runs: 5, failed: 0 }), true);
  });
  it('rejects a gain under 10%', () => {
    assert.equal(isImprovement(before, { median: 92, min: 80, max: 104, runs: 5, failed: 0 }), false);
  });
  it('rejects a gain smaller than the noisy spread', () => {
    const noisy = { median: 100, min: 60, max: 140, runs: 5, failed: 0 };
    assert.equal(isImprovement(noisy, { median: 85, min: 84, max: 86, runs: 5, failed: 0 }), false);
  });
  it('rejects when the after run has failures', () => {
    assert.equal(isImprovement(before, { median: 85, min: 83, max: 88, runs: 5, failed: 1 }), false);
  });
  it('rejects when a median is null', () => {
    assert.equal(isImprovement(before, { median: null, min: null, max: null, runs: 2, failed: 0 }), false);
    assert.equal(isImprovement({ median: null, min: null, max: null }, { median: 1, min: 1, max: 1, failed: 0 }), false);
  });
  it('honors a custom minRatio', () => {
    const tight = { median: 100, min: 99, max: 101, runs: 5, failed: 0 };
    const after = { median: 92, min: 91, max: 93, runs: 5, failed: 0 };
    assert.equal(isImprovement(tight, after), false);
    assert.equal(isImprovement(tight, after, { minRatio: 0.05 }), true);
  });
});

describe('compareReports', () => {
  it('compares only shared metrics and rounds changePct to one decimal', () => {
    const a = { label: 'a', createdAt: 't', config: {}, metrics: {
      load: { median: 300, min: 295, max: 305, runs: 3, failed: 0 },
      onlyA: { median: 1, min: 1, max: 1, runs: 3, failed: 0 },
    } };
    const b = { label: 'b', createdAt: 't', config: {}, metrics: {
      load: { median: 250, min: 248, max: 252, runs: 3, failed: 0 },
      onlyB: { median: 1, min: 1, max: 1, runs: 3, failed: 0 },
    } };
    const out = compareReports(a, b);
    assert.equal(out.length, 1);
    assert.equal(out[0].metric, 'load');
    assert.equal(out[0].changePct, -16.7);
    assert.equal(out[0].improved, true);
    assert.equal(out[0].before, a.metrics.load);
    assert.equal(out[0].after, b.metrics.load);
  });
  it('gives null changePct when a median is missing', () => {
    const s = { median: null, min: null, max: null, runs: 1, failed: 1 };
    const ok = { median: 5, min: 5, max: 5, runs: 1, failed: 0 };
    const out = compareReports({ metrics: { m: ok } }, { metrics: { m: s } });
    assert.equal(out[0].changePct, null);
    assert.equal(out[0].improved, false);
  });
});
