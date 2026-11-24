// Runs the existing collectors against the personal store, one at a time.
// Stands in for the Railway cron services: `npm run collect:personal` for one
// pass, `-- --watch 15` to repeat every 15 minutes, or name collectors to run
// only those (`-- earthquakes bundle-climate`). A collector that needs an API
// key you have not set fails on its own and the pass continues.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(SCRIPTS, '..', '.personal', 'collect-state.json');
const MIN = 60_000;

// Standalone collectors that no bundle runs, with the minutes a successful run
// stays good for. A pass skips one whose last success is younger than that, so
// `--watch 15` does not refetch daily and weekly sources every 15 minutes.
// Roughly a third of each dataset's maxStaleMin in api/health.js.
export const STANDALONE_INTERVAL_MIN = {
  'kr-customs-trade': 1440,
  'world-relations': 1440,
  'market-quotes': 15, 'commodity-quotes': 15, 'crypto-sectors': 30, 'fear-greed': 240,
  'shipping-stress': 15,
  'news-threat-summary': 15,
  'market-breadth': 1440, 'aaii-sentiment': 1440, 'cot': 1440, 'earnings-calendar': 360,
  'economic-calendar': 360, 'economy': 45, 'fred-rates': 60, 'fx-rates': 1440, 'fx-yoy': 480,
  'fuel-prices': 1440, 'electricity-prices': 360, 'ember-electricity': 1440, 'energy-spine': 1440,
  'energy-intelligence': 240, 'chokepoint-flows': 240, 'hormuz': 720, 'supply-chain-trade': 360,
  'transit-summaries': 10,
  'trade-flows': 960, 'comtrade-bilateral-hs4': 1440, 'hs2-chokepoint-exposure': 1440,
  'grocery-basket': 1440, 'sanctions-pressure': 240, 'regulatory-actions': 120,
  'gdelt-intel': 15, 'gdelt-bulk-materializer': 60, 'security-advisories': 30, 'ukmto-incidents': 20,
  'thermal-escalation': 120, 'military-cii': 15, 'military-maritime-news': 60, 'infra': 15,
  'aviation': 30, 'notam-nms': 30, 'ioda-outages': 30, 'fire-detections': 60, 'radiation-watch': 15,
  'imd-cyclone-marine': 60, 'no2-activity': 1440, 'cve-reference': 720, 'research': 45,
  'country-history': 1440, 'webcams': 480, 'forecast-resolutions': 720, 'forecast-bets': 720,
  'funding-stress': 240,
  'treasury-auctions': 60,
  'pink-sheet': 1440,
  'imf-cofer': 1440,
  'gpr': 360,
  'oecd-cli': 1440,
  'federal-register': 60,
  'dart-disclosures': 30,
  'ecos-macro': 720,
  'gpsjam': 360, 'eu-gas-flows': 360,
  // The index counts a spike only over consecutive ~15-minute readings.
  'pizzint': 15,
};

// These fetchers have explicit per-source pacing and multi-minute worst cases.
// The generic six-minute child cap killed them before their own deadline / quota
// breaker could publish a partial result, leaving their Redis locks alive much
// longer than collect-state considered the run fresh.
export const PERSONAL_COLLECTOR_TIMEOUT_MIN = Object.freeze({
  'no2-activity': 15, // seed fetch phase is capped at 12 minutes
  'supply-chain-trade': 20, // seed deadline is 17 minutes (15m lock + 2m margin)
  'comtrade-bilateral-hs4': 27, // longer pass than the 6m generic cap, still below its 30m lock
});

export function collectorTimeoutMs(name) {
  return (name.startsWith('bundle-') ? 30 : PERSONAL_COLLECTOR_TIMEOUT_MIN[name] ?? 6) * MIN;
}

// Collectors whose script is not named seed-<name>.mjs.
const SCRIPT_ALIASES = { gpsjam: 'fetch-gpsjam.mjs' };

// Bundles skip their own members while those are still fresh, so repeating a
// pass is cheap. Standalone collectors without an interval run every pass.
// news-digest builds the news:digest:v1 cells that insights, forecasts and
// digest-notifications read, so it runs first; those readers run last, after
// everything they summarise. digest-notifications composes the owner's daily
// brief and decides on its own whether to regenerate the prose this pass.
export const DEFAULT_COLLECTORS = [
  'news-digest', 'news-threat-summary', 'earthquakes', 'natural-events', 'weather-alerts', 'internet-outages', 'cyber-threats',
  'unrest-events', 'military-flights', 'conflict-intel', 'prediction-markets', 'service-statuses',
  'bundle-market-backup', 'bundle-relay-backup', 'bundle-climate', 'bundle-health',
  'bundle-energy-sources', 'bundle-derived-signals',
  'bundle-macro', 'bundle-yield-curves', 'bundle-ecb-eu', 'bundle-imf-extended', 'bundle-canada',
  'bundle-portwatch', 'bundle-portwatch-port-activity', 'bundle-regional-energy', 'bundle-regional',
  'bundle-static-ref', 'bundle-static-ref-heavy', 'bundle-resilience', 'bundle-resilience-recovery',
  'bundle-resilience-energy-v2', 'bundle-resilience-validation',
  ...Object.keys(STANDALONE_INTERVAL_MIN).filter((name) => name !== 'news-threat-summary'),
  'insights', 'world-relations-ai', 'forecasts', 'correlation', 'digest-notifications', 'world-overview',
];

export function collectorScript(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid collector name: ${name}`);
  const file = path.join(SCRIPTS, SCRIPT_ALIASES[name] ?? `seed-${name}.mjs`);
  if (!existsSync(file)) throw new Error(`Unknown collector: ${name} (no scripts/seed-${name}.mjs)`);
  return file;
}

// The collectors of `names` that are due at `now`, given the last successful
// run times in `state` ({ name: epochMs }).
export function dueCollectors(names, state, now = Date.now()) {
  return names.filter((name) => {
    const every = STANDALONE_INTERVAL_MIN[name];
    const last = state[name];
    return !every || !Number.isFinite(last) || now - last >= every * MIN;
  });
}

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}

function writeState(state) {
  try {
    mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  } catch (error) {
    console.warn(`수집 기록을 저장하지 못했습니다: ${error.message}`);
  }
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

export async function collectOnce(names, { log = console.log, force = false } = {}) {
  const state = readState();
  const due = force ? names : dueCollectors(names, state);
  if (due.length < names.length) log(`아직 신선한 수집기 ${names.length - due.length}개는 건너뜁니다.`);
  const results = [];
  for (const name of due) {
    const result = await runOne(name, collectorTimeoutMs(name));
    results.push(result);
    if (name === 'no2-activity' && result.ok && result.tail.includes('NO SOURCE: EARTHDATA_TOKEN unset')) {
      result.skipped = true;
      log('SKIP no2-activity (EARTHDATA_TOKEN unset)');
      continue;
    }
    log(`${result.ok ? ' OK ' : 'FAIL'} ${name} (${result.seconds}s)`);
    if (result.ok) {
      state[name] = Date.now();
      writeState(state);
    } else {
      const reason = result.tail.trim().split('\n').filter(Boolean).slice(-2).join(' | ');
      log(`      ${reason.slice(0, 300) || `exit ${result.code}`}`);
    }
  }
  const failed = results.filter((r) => !r.ok).length;
  const skipped = results.filter((r) => r.skipped).length;
  log(`완료: 성공 ${results.length - failed - skipped}개, 실패 ${failed}개${skipped ? `, 건너뜀 ${skipped}개` : ''}`);
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
    // Naming collectors explicitly runs them even when they are still fresh.
    await collectOnce(selected, { force: names.length > 0 });
    if (!watchMinutes) return;
    console.log(`${watchMinutes}분 뒤 다시 수집합니다. 중지하려면 Ctrl+C.`);
    await new Promise((resolve) => setTimeout(resolve, watchMinutes * MIN));
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
