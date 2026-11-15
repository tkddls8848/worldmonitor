// Runs each test file separately (4 at a time, 120 s each) and returns
// Record<file, 'pass'|'fail'>. Stands in for `npm run test:related`, which
// cannot run tests on Windows.
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
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

function runFile(file, root) {
  return new Promise((done) => {
    const args = file.endsWith('.mts') ? ['--import', 'tsx', '--test', file] : ['--test', file];
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill(), 120_000);
    child.on('close', (code) => { clearTimeout(timer); done(code === 0 ? 'pass' : 'fail'); });
    child.on('error', () => { clearTimeout(timer); done('fail'); });
  });
}

export async function runTests({ root = ROOT, concurrency = 4 } = {}) {
  const files = listTestFiles(root);
  const result = {};
  let next = 0;
  async function worker() {
    while (next < files.length) {
      const file = files[next++];
      result[file] = await runFile(file, root);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const r = await runTests();
  const fails = Object.entries(r).filter(([, s]) => s === 'fail').map(([f]) => f);
  console.log(`${Object.keys(r).length - fails.length} pass, ${fails.length} fail`);
  for (const f of fails) console.log(`FAIL ${f}`);
}
