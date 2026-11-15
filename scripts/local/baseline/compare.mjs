// node scripts/local/baseline/compare.mjs <baseLabel> <afterLabel>
// Prints differences; last line is PASS or FAIL.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { diffKeySets, diffScenarioRuns, diffTestRuns } from './diff.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const [baseLabel, afterLabel] = process.argv.slice(2);
if (!baseLabel || !afterLabel) { console.error('usage: compare.mjs <baseLabel> <afterLabel>'); process.exit(2); }
const load = (label, name) => JSON.parse(readFileSync(resolve(ROOT, '.personal/baseline', label, name), 'utf8'));
let ok = true;

const scen = diffScenarioRuns(load(baseLabel, 'scenarios.json'), load(afterLabel, 'scenarios.json'));
console.log(`scenario differences: ${scen.length}`);
scen.forEach((l) => console.log(`  ${l}`));
if (scen.length) ok = false;

for (const name of ['bootstrap-keys.json', 'health-keys.json']) {
  const d = diffKeySets(load(baseLabel, name), load(afterLabel, name));
  console.log(`${name}: removed ${d.removed.length}, added ${d.added.length}`);
  d.removed.forEach((k) => console.log(`  - ${k}`));
  d.added.forEach((k) => console.log(`  + ${k}`));
  if (d.added.length) ok = false;
}

const t = diffTestRuns(load(baseLabel, 'tests.json'), load(afterLabel, 'tests.json'));
console.log(`tests: newly failing ${t.newlyFailing.length}, removed files ${t.removedFiles.length}`);
t.newlyFailing.forEach((f) => console.log(`  FAIL ${f}`));
t.removedFiles.forEach((f) => console.log(`  removed ${f}`));
if (t.newlyFailing.length) ok = false;

const bc = load(baseLabel, 'checks.json');
const ac = load(afterLabel, 'checks.json');
for (const k of ['typecheckErrors', 'boundaryErrors']) {
  console.log(`${k}: ${bc[k]} -> ${ac[k]}`);
  if (ac[k] > bc[k]) { ok = false; console.log(`  ${k} increased`); }
}
const bl = load(baseLabel, 'loc.json');
const al = load(afterLabel, 'loc.json');
console.log(`loc: ${bl.lines} -> ${al.lines} (${al.lines - bl.lines})`);
console.log(ok ? 'PASS' : 'FAIL');
process.exitCode = ok ? 0 : 1;
