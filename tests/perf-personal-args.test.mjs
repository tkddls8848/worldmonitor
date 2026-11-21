import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  METRIC_NAMES,
  USAGE,
  buildReport,
  collectRuns,
  layerDrawn,
  parseArgs,
} from '../scripts/perf-personal.mjs';

describe('perf-personal parseArgs', () => {
  it('defaults to 5 runs, cpu 1 and one warm-up run', () => {
    assert.deepEqual(parseArgs(['--label', 'baseline']), { mode: 'measure', label: 'baseline', runs: 5, cpu: 1, warmup: 1 });
  });
  it('reads --runs, --cpu and --warmup', () => {
    const a = parseArgs(['--label', 'x', '--runs', '3', '--cpu', '4', '--warmup', '0']);
    assert.equal(a.runs, 3);
    assert.equal(a.cpu, 4);
    assert.equal(a.warmup, 0);
  });
  it('reads --compare', () => {
    const a = parseArgs(['--compare', 'baseline', 'no-globe']);
    assert.equal(a.mode, 'compare');
    assert.deepEqual(a.compare, ['baseline', 'no-globe']);
  });
  it('rejects unsafe labels, empty args and a negative warm-up', () => {
    assert.throws(() => parseArgs(['--label', '../x']));
    assert.throws(() => parseArgs([]));
    assert.throws(() => parseArgs(['--label', 'x', '--warmup', '-1']));
  });
  it('answers --help with the usage text, which documents the warm-up and the raw samples', () => {
    assert.deepEqual(parseArgs(['--help']), { mode: 'help' });
    assert.match(USAGE, /--warmup <n>/);
    assert.match(USAGE, /discarded/);
    assert.match(USAGE, /"samples"/);
  });
});

describe('perf-personal collectRuns and buildReport', () => {
  // A fake run: every metric gets the run number, except a failed layer result.
  const fakeRun = (calls) => async (run) => {
    calls.push(run);
    const values = Object.fromEntries(METRIC_NAMES.map((n) => [n, run * 10]));
    values['layer.resultVisible'] = run === 2 ? null : run * 10;
    values['cold.tbt'] = run === 3 ? Number.NaN : run * 10;
    return {
      values,
      failures: run === 2 ? [{ what: 'layer', error: 'result not visible within 15s' }] : [],
      loads: [{ panels: ['cii'], erroredPanels: [] }],
    };
  };

  it('discards the warm-up runs and keeps the measured runs as raw samples', async () => {
    const calls = [];
    const logs = [];
    const out = await collectRuns({ runs: 3, warmup: 1, measureRun: fakeRun(calls), log: (m) => logs.push(m) });
    assert.deepEqual(calls, [0, 1, 2, 3], 'one warm-up run (run 0) before the three measured runs');
    assert.deepEqual(logs, ['warm-up 1/1 (discarded)', 'run 1/3', 'run 2/3', 'run 3/3']);
    assert.deepEqual(Object.keys(out.samples), METRIC_NAMES);
    assert.deepEqual(out.samples['cold.mapReady'], [10, 20, 30]);
    assert.deepEqual(out.samples['layer.resultVisible'], [10, null, 30], 'a failed sample stays null');
    assert.deepEqual(out.samples['cold.tbt'], [10, 20, null], 'a non-finite sample is a failure');
    assert.deepEqual(out.failures, [{ run: 2, what: 'layer', error: 'result not visible within 15s' }]);
    assert.equal(out.loads.length, 3, 'warm-up loads are not counted');
  });

  it('runs no warm-up when asked for zero', async () => {
    const calls = [];
    await collectRuns({ runs: 2, warmup: 0, measureRun: fakeRun(calls), log: () => {} });
    assert.deepEqual(calls, [1, 2]);
  });

  it('saves the raw samples next to the summaries', async () => {
    const { samples, failures } = await collectRuns({ runs: 3, warmup: 1, measureRun: fakeRun([]), log: () => {} });
    const report = buildReport({ label: 'x', createdAt: 't', config: { runs: 3 }, samples, failures });
    assert.deepEqual(report.samples['layer.resultVisible'], [10, null, 30]);
    assert.deepEqual(report.metrics['layer.resultVisible'], { median: 20, min: 10, max: 30, spread: 20, runs: 3, failed: 1 });
    assert.deepEqual(report.metrics['cold.mapDemand'], { median: 20, min: 10, max: 30, spread: 10, runs: 3, failed: 0 });
    assert.ok('warm.mapAfterDemand' in report.metrics);
    assert.deepEqual(report.failures, failures);
  });
});

describe('perf-personal layer result predicate', () => {
  const args = { layer: 'cables', deckLayerId: 'cables-layer' };
  const page = (over = {}) => ({
    __wmLayerEl: { checked: true },
    __wmT0: 1000,
    __wmLcpDebug: { enabled: true, marks: [], deckLayers: { at: 1040, ids: ['base-layer', 'cables-layer'] } },
    __wmLastDrawAt: 1050,
    ...over,
  });

  it('is done once a frame was drawn after the app committed the toggled layer', () => {
    assert.equal(layerDrawn(args, page()), true);
  });
  it('waits while the checkbox is still off', () => {
    assert.equal(layerDrawn(args, page({ __wmLayerEl: { checked: false } })), false);
  });
  it('waits for a commit that holds the toggled layer', () => {
    assert.equal(layerDrawn(args, page({ __wmLcpDebug: { enabled: true, marks: [] } })), false);
    assert.equal(layerDrawn(args, page({
      __wmLcpDebug: { enabled: true, marks: [], deckLayers: { at: 1040, ids: ['base-layer'] } },
    })), false);
  });
  it('ignores a commit from before the input', () => {
    assert.equal(layerDrawn(args, page({
      __wmLcpDebug: { enabled: true, marks: [], deckLayers: { at: 990, ids: ['cables-layer'] } },
    })), false);
  });
  it('waits for a draw after the commit', () => {
    assert.equal(layerDrawn(args, page({ __wmLastDrawAt: 1030 })), false);
    assert.equal(layerDrawn(args, page({ __wmLastDrawAt: 1040 })), false);
    assert.equal(layerDrawn(args, page({ __wmLastDrawAt: null })), false);
  });
  it('does not read the URL layers state the app writes on a debounce', () => {
    assert.doesNotMatch(layerDrawn.toString(), /location|searchParams/);
  });
  it('stays self-contained so it can be serialised into the page', () => {
    // The runner rebuilds it from its source text, as it does in the browser.
    const rebuilt = new Function('args', 'w', `return (${layerDrawn.toString()})(args, w)`);
    assert.equal(rebuilt(args, page()), true);
    assert.equal(rebuilt(args, page({ __wmLastDrawAt: 1030 })), false);
  });
});
