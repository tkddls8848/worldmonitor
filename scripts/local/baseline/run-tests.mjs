// Runs each test file separately (4 at a time, 120 s each) and returns
// Record<file, 'pass'|'fail'>. Stands in for `npm run test:related`, which
// cannot run tests on Windows.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { parseJunit } from './diff.mjs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(import.meta.url), '../../../..');

export function listTestFiles(root = ROOT) {
  const out = [];
  for (const dir of ['tests', 'cli/test']) {
    let names = [];
    try { names = readdirSync(join(root, dir)); } catch { continue; }
    for (const n of names) {
      if (dir === 'tests' && /\.test\.m(js|ts)$/.test(n)) out.push(`${dir}/${n}`);
      if (dir === 'cli/test' && /\.test\.mjs$/.test(n)) out.push(`${dir}/${n}`);
    }
  }
  return out.sort();
}

// Returns Record<"<file> :: <test path>", 'pass'|'fail'> for one file. A file
// that cannot be loaded, crashes, or times out gets "<file> :: <file-load>".
function runFile(file, root) {
  return new Promise((done) => {
    const dir = mkdtempSync(join(tmpdir(), 'wm-junit-'));
    const report = join(dir, 'report.xml');
    const args = [...(file.endsWith('.mts') ? ['--import', 'tsx'] : []), '--test',
      '--test-reporter=junit', '--test-reporter-destination=' + report, file];
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'ignore' });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, 120_000);
    const finish = (code) => {
      clearTimeout(timer);
      let tests = {};
      try { tests = parseJunit(readFileSync(report, 'utf8')); } catch { /* no report */ }
      rmSync(dir, { recursive: true, force: true });
      const out = {};
      for (const [name, status] of Object.entries(tests)) out[file + ' :: ' + name] = status;
      if (timedOut || Object.keys(out).length === 0) out[file + ' :: <file-load>'] = code === 0 && !timedOut ? 'pass' : 'fail';
      else if (code !== 0 && !Object.values(out).includes('fail')) out[file + ' :: <file-load>'] = 'fail';
      done(out);
    };
    child.on('close', finish);
    child.on('error', () => finish(1));
  });
}

export async function runTests({ root = ROOT, concurrency = 4 } = {}) {
  const files = listTestFiles(root);
  const result = {};
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      Object.assign(result, await runFile(file, root));
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const r = await runTests();
  const fails = Object.entries(r).filter(([, s]) => s === 'fail').map(([f]) => f);
  console.log(Object.keys(r).length - fails.length + ' pass, ' + fails.length + ' fail');
  for (const f of fails) console.log('FAIL ' + f);
}
