// Records a deterministic baseline under .personal/baseline/<label>/.
//   node scripts/local/baseline/capture.mjs --label base
// Needs the personal server running (npm run start:personal) and .env.local.
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLocalScenario } from '../../run-local-scenario.mjs';
import { SCENARIO_TEMPLATES } from '../../scenario-worker.mjs';
import { countErrors } from './diff.mjs';
import { runTests } from './run-tests.mjs';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');
const { values } = parseArgs({ options: { label: { type: 'string' } } });
if (!values.label || !/^[\w.-]+$/.test(values.label)) throw new Error('--label <name> is required');
const out = resolve(ROOT, '.personal/baseline', values.label);
mkdirSync(out, { recursive: true });
const save = (name, data) => writeFileSync(resolve(out, name), `${JSON.stringify(data, null, 2)}\n`);

function readEnv(file) {
  const env = {};
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return env;
}
// Returns { exitCode, output }; a failing command is never silently treated as clean.
function run(cmd) {
  try {
    return { exitCode: 0, output: execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 28 }) };
  } catch (e) {
    return { exitCode: typeof e.status === 'number' ? e.status : 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}
const sh = (cmd) => run(cmd).output;

save('meta.json', {
  commit: sh('git rev-parse HEAD').trim(), node: process.version, capturedAt: new Date().toISOString(),
});

// Scenarios: fixed snapshot, template-default intensity, countries null and KR.
const snapshot = JSON.parse(readFileSync(resolve(ROOT, 'tests/fixtures/scenario/baseline-snapshot.json'), 'utf8'));
const scenarios = [];
for (const t of SCENARIO_TEMPLATES) {
  for (const country of [null, 'KR']) {
    let result = await runLocalScenario(snapshot, t.id, country);
    // "missing" means the compute time budget ran out; retry once.
    if (result?.coverage?.status === 'missing') result = await runLocalScenario(snapshot, t.id, country);
    scenarios.push({ scenarioId: t.id, country, result });
  }
}
save('scenarios.json', scenarios);

// Bootstrap and health: key names only.
const env = readEnv(resolve(ROOT, '.env.local'));
const auth = `Basic ${Buffer.from(`${env.WM_PERSONAL_USERNAME || 'owner'}:${env.WM_PERSONAL_PASSWORD}`).toString('base64')}`;
const base = `http://127.0.0.1:${env.WM_PERSONAL_PORT || 3000}`;
// /api/bootstrap wants an anonymous session token on top of the Basic login.
const session = await (await fetch(`${base}/api/wm-session`, { method: 'POST', headers: { Authorization: auth } })).json();
async function getJson(path, attempt = 0) {
  const res = await fetch(base + path, { headers: { Authorization: auth, 'X-WorldMonitor-Key': session.token }, signal: AbortSignal.timeout(60_000) });
  if (res.status === 503 && attempt < 12) { // health answers 503 while its background refresh is pending
    await new Promise((r) => setTimeout(r, 5_000));
    return getJson(path, attempt + 1);
  }
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}
const bootstrapKeys = [];
for (const tier of ['fast', 'slow']) {
  const body = await getJson(`/api/bootstrap?tier=${tier}`);
  bootstrapKeys.push(...Object.keys(body.data ?? body));
}
save("bootstrap-keys.json", [...new Set(bootstrapKeys)].sort()); // tier dropped: a key moving between tiers is not a removal
const health = await getJson('/api/health?compact=1');
save('health-keys.json', healthKeys(health));

function healthKeys(h) {
  // Compact health lists entries under a few groupings; collect every name found.
  const names = new Set();
  for (const [group, value] of Object.entries(h)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      for (const k of Object.keys(value)) names.add(`${group}:${k}`);
    } else if (Array.isArray(value)) {
      for (const k of value) names.add(`${group}:${typeof k === 'string' ? k : JSON.stringify(k)}`);
    }
  }
  return [...names].sort();
}

save('tests.json', await runTests());
{
  // The full test run can rewrite or delete tracked files (public/llms.txt, .antigravity-plugin/).
  const dirty = sh('git status --porcelain').split(/\r?\n/).filter((l) => l && !l.startsWith('??'));
  if (dirty.length) console.log('WARNING: tests changed tracked files (restore with git checkout -- <path>):\n' + dirty.join('\n'));
}

save('checks.json', {
  typecheckErrors: countErrors(run('npm run typecheck'), /error TS\d+/),
  boundaryErrors: countErrors(run('npm run lint:boundaries'), /\b(error|violation)\b/i),
});

const files = sh('git ls-files').split(/\r?\n/).filter((f) =>
  /\.(ts|tsx|js|mjs|cjs|mts)$/.test(f) && !/^(tests|e2e|docs|src\/generated)\//.test(f) && !/\.generated\./.test(f));
let lines = 0;
for (const f of files) {
  try {
    const t = readFileSync(resolve(ROOT, f), 'utf8');
    lines += t.length ? t.split('\n').length : 0;
  } catch { /* file deleted in working tree */ }
}
save('loc.json', { files: files.length, lines });
console.log(`baseline "${values.label}" written to ${out}`);
