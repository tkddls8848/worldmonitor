// Runs the existing collectors against the personal store, one at a time.
// Stands in for the Railway cron services: `npm run collect:personal` for one
// pass, `-- --watch 15` to repeat every 15 minutes, or name collectors to run
// only those (`-- earthquakes bundle-climate`). A collector that needs an API
// key you have not set fails on its own and the pass continues.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;

// Bundles skip their own members while those are still fresh, so repeating a
// pass is cheap. Standalone collectors run every pass. digest-notifications
// composes the owner's daily brief and decides on its own whether to
// regenerate the prose this pass.
export const DEFAULT_COLLECTORS = [
  'earthquakes', 'natural-events', 'weather-alerts', 'internet-outages', 'cyber-threats',
  'unrest-events', 'military-flights', 'conflict-intel', 'prediction-markets', 'service-statuses',
  'bundle-market-backup', 'bundle-relay-backup', 'bundle-climate', 'bundle-health',
  'bundle-energy-sources', 'bundle-derived-signals', 'insights', 'forecasts', 'correlation',
  'digest-notifications',
];

export function collectorScript(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid collector name: ${name}`);
  const file = path.join(SCRIPTS, `seed-${name}.mjs`);
  if (!existsSync(file)) throw new Error(`Unknown collector: ${name} (no scripts/seed-${name}.mjs)`);
  return file;
}

function runOne(name, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [collectorScript(name)], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ name, ok: code === 0, code, seconds: Math.round((Date.now() - started) / 1000), tail });
    });
  });
}

export async function collectOnce(names, { log = console.log } = {}) {
  const results = [];
  for (const name of names) {
    const result = await runOne(name, (name.startsWith('bundle-') ? 30 : 6) * MIN);
    results.push(result);
    log(`${result.ok ? ' OK ' : 'FAIL'} ${name} (${result.seconds}s)`);
    if (!result.ok) {
      const reason = result.tail.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
      log(`      ${reason.slice(0, 300) || `exit ${result.code}`}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  log(`완료: 성공 ${results.length - failed}개, 실패 ${failed}개`);
  return results;
}

async function main(argv) {
  let watchMinutes = 0;
  const names = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--watch') watchMinutes = Math.max(1, Number(argv[++i]) || 15);
    else names.push(argv[i]);
  }
  const selected = names.length ? names : DEFAULT_COLLECTORS;
  selected.forEach(collectorScript); // reject a typo before the first run
  for (;;) {
    await collectOnce(selected);
    if (!watchMinutes) return;
    console.log(`${watchMinutes}분 뒤 다시 수집합니다. 중지하려면 Ctrl+C.`);
    await new Promise((resolve) => setTimeout(resolve, watchMinutes * MIN));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
