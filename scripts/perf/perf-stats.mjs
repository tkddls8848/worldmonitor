// Pure statistics for the frontend performance runner. Lower is better.
// A null sample is a failed measurement: it is counted, never treated as 0.

export function summarize(samples) {
  const ok = samples.filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  const base = { runs: samples.length, failed: samples.length - ok.length };
  if (ok.length === 0) return { median: null, min: null, max: null, spread: null, ...base };
  const mid = Math.floor(ok.length / 2);
  const median = ok.length % 2 ? ok[mid] : (ok[mid - 1] + ok[mid]) / 2;
  return { median, min: ok[0], max: ok[ok.length - 1], spread: spreadOfSorted(ok), ...base };
}

// Spread used by the improvement rule: max - min without the single slowest
// sample, so one spiky run cannot veto a real gain (owner decision, spec 8.9
// option 1). With fewer than three successful samples there is nothing to
// drop safely, so it stays max - min.
function spreadOfSorted(ok) {
  if (ok.length === 0) return null;
  const top = ok.length >= 3 ? ok[ok.length - 2] : ok[ok.length - 1];
  return top - ok[0];
}

// Reports saved before `spread` existed carry only median/min/max.
function spreadOf(summary) {
  return typeof summary.spread === 'number' ? summary.spread : summary.max - summary.min;
}

export function isImprovement(before, after, { minRatio = 0.10 } = {}) {
  if (after.failed > 0) return false;
  if (before.median == null || after.median == null) return false;
  const gain = before.median - after.median;
  if (gain < before.median * minRatio) return false;
  const spread = Math.max(spreadOf(before), spreadOf(after));
  return gain > spread;
}

export function compareReports(a, b) {
  const rows = [];
  for (const metric of Object.keys(a.metrics)) {
    if (!(metric in b.metrics)) continue;
    const before = a.metrics[metric];
    const after = b.metrics[metric];
    const changePct = before.median == null || after.median == null || before.median === 0
      ? null
      : Math.round(((after.median - before.median) / before.median) * 1000) / 10;
    // Older reports have no saved spread but do keep raw samples: judge with them.
    const judgeBefore = withSampleSpread(before, a.samples?.[metric]);
    const judgeAfter = withSampleSpread(after, b.samples?.[metric]);
    rows.push({ metric, before, after, changePct, improved: isImprovement(judgeBefore, judgeAfter) });
  }
  return rows;
}

function withSampleSpread(summary, samples) {
  if (typeof summary.spread === 'number' || !Array.isArray(samples)) return summary;
  return { ...summary, spread: summarize(samples).spread };
}

// Metrics only one report has (a metric added or dropped between tool
// versions). compareReports skips them; the comparison output names them.
export function unmatchedMetrics(a, b) {
  return {
    onlyA: Object.keys(a.metrics).filter((m) => !(m in b.metrics)),
    onlyB: Object.keys(b.metrics).filter((m) => !(m in a.metrics)),
  };
}
