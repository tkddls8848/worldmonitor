// Pure comparison helpers for the phase-1 baseline tools.

function strip(value) {
  if (Array.isArray(value)) return value.map(strip);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) if (k !== 'computedAt') out[k] = strip(value[k]);
    return out;
  }
  return value;
}

function walk(a, b, path, lines) {
  if (JSON.stringify(a) === JSON.stringify(b)) return;
  const isObj = (v) => v && typeof v === 'object';
  if (isObj(a) && isObj(b) && Array.isArray(a) === Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of [...keys].sort()) walk(a[k], b[k], `${path}.${k}`, lines);
    return;
  }
  lines.push(`${path}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
}

export function diffScenarioRuns(base, after) {
  const lines = [];
  const n = Math.max(base.length, after.length);
  for (let i = 0; i < n; i++) walk(strip(base[i]), strip(after[i]), `[${i}]`, lines);
  return lines;
}

export function diffKeySets(base, after) {
  const b = new Set(base), a = new Set(after);
  return { removed: base.filter((k) => !a.has(k)), added: after.filter((k) => !b.has(k)) };
}

export function diffTestRuns(base, after) {
  const newlyFailing = [];
  for (const [file, status] of Object.entries(after)) {
    if (status === 'fail' && base[file] !== 'fail' ) newlyFailing.push(file);
  }
  const removedFiles = Object.keys(base).filter((f) => !(f in after));
  return { newlyFailing, removedFiles };
}

// Error count from a command result, or null when the command failed without
// printing any recognisable error line (crash, missing script, OOM).
export function countErrors({ exitCode, output }, pattern) {
  const n = output.split(/\r?\n/).filter((l) => pattern.test(l)).length;
  if (n === 0 && exitCode !== 0) return null;
  return n;
}
