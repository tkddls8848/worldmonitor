// Runs the existing collectors against the personal store.
// Stands in for the Railway cron services: `npm run collect:personal` for one
// pass, `-- --watch 15` to repeat every 15 minutes, or name collectors to run
// only those (`-- earthquakes bundle-climate`). A collector that needs an API
// key you have not set fails on its own and the pass continues.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SOURCE_SKIPPED_EXIT_CODE } from './_seed-utils.mjs';
import { PERSONAL_TASKS } from './seed-personal-task.mjs';

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.resolve(SCRIPTS, '..', '.personal', 'collect-state.json');
const MIN = 60_000;

// Standalone collectors that no bundle runs, with the minutes a successful run
// stays good for. A pass skips one whose last success is younger than that, so
// `--watch 15` does not refetch daily and weekly sources every 15 minutes.
// Roughly a third of each dataset's maxStaleMin in api/health.js.
export const STANDALONE_INTERVAL_MIN = {
  ...Object.fromEntries(Object.entries(PERSONAL_TASKS).map(([name, entry]) => [name, entry[2]])),
  'weather-alerts': 15, 'cyber-threats': 120,
  'kr-customs-trade': 1440,
  'world-relations': 1440,
  'market-quotes': 15, 'commodity-quotes': 15, 'fear-greed': 240,
  'shipping-stress': 15,
  'news-threat-summary': 15,
  'market-breadth': 1440, 'cot': 1440, 'earnings-calendar': 360,
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
  'country-history': 1440, 'forecast-resolutions': 720, 'forecast-bets': 720,
  'funding-stress': 240,
  'treasury-auctions': 60,
  'pink-sheet': 1440,
  'imf-cofer': 1440,
  'gpr': 360,
  'oecd-cli': 1440,
  'federal-register': 60,
  'impact-links': 30,
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
  'bundle-country-reference': 65, // monthly import HHI can take 30 minutes on its own
  'no2-activity': 15, // seed fetch phase is capped at 12 minutes
  'supply-chain-trade': 20, // seed deadline is 17 minutes (15m lock + 2m margin)
  'comtrade-bilateral-hs4': 27, // longer pass than the 6m generic cap, still below its 30m lock
});

export function collectorTimeoutMs(name) {
  return (PERSONAL_COLLECTOR_TIMEOUT_MIN[name] ?? (name.startsWith('bundle-') ? 30 : 6)) * MIN;
}

// Collectors whose script is not named seed-<name>.mjs.
const SCRIPT_ALIASES = { gpsjam: 'fetch-gpsjam.mjs' };

// Bundles skip their own members while those are still fresh, so repeating a
// pass is cheap. Standalone collectors without an interval run every pass.
// news-threat-summary warms the news:digest:v1 cells that insights, forecasts and
// digest-notifications read, so it runs first; those readers run last, after
// everything they summarise. digest-notifications composes the owner's daily
// brief and decides on its own whether to regenerate the prose this pass.

export const DEFAULT_COLLECTORS = [
  'news-threat-summary', 'earthquakes', 'natural-events', 'weather-alerts', 'internet-outages', 'cyber-threats',
  'unrest-events', 'military-flights', 'conflict-intel', 'prediction-markets', 'service-statuses',
  'bundle-market-backup', 'bundle-relay-backup', 'bundle-climate', 'bundle-health',
  'bundle-energy-sources', 'bundle-derived-signals',
  'bundle-macro', 'bundle-yield-curves', 'bundle-ecb-eu', 'bundle-imf-extended',
  'bundle-portwatch', 'bundle-portwatch-port-activity', 'bundle-regional-energy', 'bundle-country-reference', 'bundle-regional',
  'bundle-static-ref', 'bundle-static-ref-heavy',
  ...Object.keys(STANDALONE_INTERVAL_MIN).filter((name) => !['news-threat-summary', 'weather-alerts', 'cyber-threats', 'impact-links'].includes(name)),
  'insights', 'world-relations-ai', 'forecasts', 'correlation', 'digest-notifications', 'impact-links', 'world-overview',
];

// The bulk pass can take longer than these cadences even on a healthy machine.
const FAST_WATCH_GROUPS = [
  { names: ['news-threat-summary'], every: STANDALONE_INTERVAL_MIN['news-threat-summary'] },
  { names: ['shipping-stress'], every: STANDALONE_INTERVAL_MIN['shipping-stress'] },
  { names: ['transit-summaries'], every: STANDALONE_INTERVAL_MIN['transit-summaries'] },
];

export function collectorWatchGroups(selected, watchMinutes, force) {
  if (force) return [{ names: selected, every: watchMinutes, force }];
  const fastNames = new Set(FAST_WATCH_GROUPS.flatMap(({ names }) => names));
  return [
    ...FAST_WATCH_GROUPS.map((group) => ({ ...group, force: true, fixedCadence: true })),
    { names: selected.filter((name) => !fastNames.has(name)), every: watchMinutes, force: false },
  ];
}

export function collectorScript(name) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`Invalid collector name: ${name}`);
  const file = path.join(SCRIPTS, PERSONAL_TASKS[name] ? 'seed-personal-task.mjs' : SCRIPT_ALIASES[name] ?? `seed-${name}.mjs`);
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

function runOne(name, timeoutMs, log) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [collectorScript(name), ...(PERSONAL_TASKS[name] ? [name] : [])], { stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk).slice(-2000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    if (name.startsWith('bundle-')) {
      createInterface({ input: child.stdout }).on('line', (line) => {
        if (/^\[Bundle:[^\]]+\] section=\S+ status=SKIPPED reason=/.test(line)) log(`      ${line}`);
      });
    }
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
    const result = await runOne(name, collectorTimeoutMs(name), log);
    results.push(result);
    if (result.code === SOURCE_SKIPPED_EXIT_CODE) {
      result.ok = true;
      result.skipped = true;
      const reason = result.tail.split(/\r?\n/).findLast((line) => line.startsWith('NO SOURCE: '));
      log(`SKIP ${name} (${reason?.slice('NO SOURCE: '.length) || 'no source data'})`);
      continue;
    }
    if (name === 'no2-activity' && result.ok && result.tail.includes('NO SOURCE: EARTHDATA_TOKEN unset')) {
      result.skipped = true;
      log('SKIP no2-activity (EARTHDATA_TOKEN unset)');
      continue;
    }
    log(`${result.ok ? ' OK ' : 'FAIL'} ${name} (${result.seconds}s)`);
    if (result.ok) {
      writeState({ ...readState(), [name]: Date.now() });
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

async function watchCollectors({ names, every, force, fixedCadence = false }) {
  for (;;) {
    const startedAt = Date.now();
    await collectOnce(names, { force });
    // Fast loops run at their feed cadence. The bulk loop and explicitly
    // selected collectors retain the configured delay after a pass.
    const passTime = fixedCadence ? Date.now() - startedAt : 0;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, every * MIN - passTime)));
  }
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
  // Naming collectors explicitly runs them even when they are still fresh.
  const force = names.length > 0;
  if (!watchMinutes) return collectOnce(selected, { force });
  return Promise.all(collectorWatchGroups(selected, watchMinutes, force).map(watchCollectors));
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
