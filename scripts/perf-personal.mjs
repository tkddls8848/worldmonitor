// Frontend performance runner for the personal dashboard.
//   npm run perf:personal -- --label <name> [--runs 5] [--cpu 1|4]
//   npm run perf:personal -- --compare <labelA> <labelB>
// Writes .personal/perf/<label>.json. A measurement that cannot be taken is
// recorded as null (failed); it is never turned into 0 and never skipped.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from './_env-file.mjs';
import { compareReports, summarize } from './perf/perf-stats.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PERF_DIR = join(ROOT, '.personal', 'perf');
const BASE_URL = process.env.WM_PERF_URL || 'http://127.0.0.1:3000';
const VIEWPORT = { width: 1600, height: 1000 };
const LOAD_TIMEOUT_MS = 60_000;
const RESULT_TIMEOUT_MS = 15_000;
const SETTLE_MS = 1500;
const EVENT_THRESHOLD_MS = 16;
// First tabbed panel of the default layout (military/cyber/nuclear/... tabs).
const TABBED_PANEL = 'gdelt-intel';

export const LOAD_METRICS = ['fcp', 'lcp', 'mapReady', 'panelsReady', 'tbt'];
export const COLD_ONLY_METRICS = ['jsBytes', 'cssBytes', 'heapMB'];
export const INTERACTIONS = ['country', 'layer', 'panel', 'search'];

export function parseArgs(argv) {
  let label;
  let runs = 5;
  let cpu = 1;
  let compare;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--label') label = argv[++i];
    else if (arg === '--runs') runs = Number(argv[++i]);
    else if (arg === '--cpu') cpu = Number(argv[++i]);
    else if (arg === '--compare') { compare = [argv[++i], argv[++i]]; }
    else throw new Error(`Unknown argument: ${arg}`);
  }
  const validLabel = (v) => typeof v === 'string' && /^[a-z0-9-]+$/.test(v);
  if (compare) {
    if (!validLabel(compare[0]) || !validLabel(compare[1])) throw new Error('--compare needs two labels matching ^[a-z0-9-]+$');
    return { mode: 'compare', runs, cpu, compare };
  }
  if (!validLabel(label)) throw new Error('--label <name> is required and must match ^[a-z0-9-]+$');
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  if (!Number.isInteger(cpu) || cpu < 1) throw new Error('--cpu must be a positive integer');
  return { mode: 'measure', label, runs, cpu };
}

// Runs in every page before any script: collects the timing entries.
function initScript(threshold) {
  window.__wmPerf = { paint: [], lcp: [], longtask: [], event: [] };
  window.__wmObservers = [];
  const observe = (type, bucket, extra) => {
    try {
      const o = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__wmPerf[bucket].push({ name: e.name, startTime: e.startTime, duration: e.duration });
        }
      });
      o.observe({ type, buffered: true, ...extra });
      window.__wmObservers.push({ o, bucket });
    } catch { /* entry type unsupported */ }
  };
  observe('paint', 'paint');
  observe('largest-contentful-paint', 'lcp');
  observe('longtask', 'longtask');
  observe('event', 'event', { durationThreshold: threshold });
  // Real input time of the first armed input, on the performance.now() clock.
  window.__wmT0 = null;
  window.__wmArm = false;
  const stamp = (e) => { if (window.__wmArm && window.__wmT0 === null) window.__wmT0 = e.timeStamp; };
  addEventListener('pointerdown', stamp, true);
  addEventListener('keydown', stamp, true);
}

// Both run in the page. They poll each frame and resolve with performance.now().
function waitMapReady() {
  return new Promise((resolve) => {
    const tick = () => {
      const c = document.querySelector('#mapContainer.deckgl-mode canvas');
      const r = c?.getBoundingClientRect();
      if (c && r.width > 0 && r.height > 0 && c.width > 0) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
      } else requestAnimationFrame(tick);
    };
    tick();
  });
}

function waitPanelsReady() {
  return new Promise((resolve) => {
    let stable = 0;
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
    };
    const tick = () => {
      const panels = [...document.querySelectorAll('#panelsGrid .panel')].filter(visible);
      // Ready means: no loading indicator and the panel body actually holds content.
      const loading = panels.some((p) => p.querySelector('.panel-loading') || !p.querySelector('.panel-content')?.children.length);
      if (panels.length > 0 && !loading) stable++; else stable = 0;
      // Two consecutive clean frames, so a panel that is about to re-render is not missed.
      if (stable >= 2) resolve(performance.now()); else requestAnimationFrame(tick);
    };
    tick();
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function openDashboard(page, cdp) {
  await page.goto(`${BASE_URL}/dashboard`, { waitUntil: 'domcontentloaded', timeout: LOAD_TIMEOUT_MS });
  // Both waits start together so neither one's timestamp depends on the other.
  const [mapReady, panelsReady] = await Promise.all([
    withTimeout(page.evaluate(waitMapReady), LOAD_TIMEOUT_MS, 'map never became ready'),
    withTimeout(page.evaluate(waitPanelsReady), LOAD_TIMEOUT_MS, 'panels never finished loading'),
  ]);
  const data = await page.evaluate(() => {
    const p = window.__wmPerf;
    const fcp = p.paint.find((e) => e.name === 'first-contentful-paint')?.startTime ?? null;
    const lcp = p.lcp.length ? p.lcp[p.lcp.length - 1].startTime : null;
    const res = performance.getEntriesByType('resource');
    const bytes = (re) => res.filter((r) => re.test(new URL(r.name).pathname)).reduce((s, r) => s + r.transferSize, 0);
    return { fcp, lcp, longtasks: p.longtask, jsBytes: bytes(/\.m?js$/), cssBytes: bytes(/\.css$/) };
  });
  const heap = (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null;
  const tbt = data.fcp == null ? null : data.longtasks
    .filter((t) => t.startTime >= data.fcp && t.startTime <= panelsReady)
    .reduce((s, t) => s + Math.max(0, t.duration - 50), 0);
  return {
    fcp: data.fcp, lcp: data.lcp, mapReady, panelsReady, tbt,
    jsBytes: data.jsBytes, cssBytes: data.cssBytes,
    heapMB: heap == null ? null : heap / (1024 * 1024),
  };
}

async function newSession(browser, cpu, env) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    httpCredentials: { username: env.WM_PERSONAL_USERNAME || 'owner', password: env.WM_PERSONAL_PASSWORD || '' },
  });
  await context.addInitScript(initScript, EVENT_THRESHOLD_MS);
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  return { context, page, cdp };
}

// Per-interaction: how to trigger it (`act`) and how the page recognises the
// result (`done`, evaluated in the page once per frame).
const INTERACTION_DEFS = {
  country: {
    async act(page) { await page.locator('.cii-country').first().click({ timeout: RESULT_TIMEOUT_MS }); },
    done: () => {
      const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      return vis(document.querySelector('.country-brief-overlay')) || vis(document.querySelector('#country-deep-dive-panel'));
    },
  },
  layer: {
    async act(page) {
      const handle = await page.evaluateHandle(() => {
        const inputs = [...document.querySelectorAll('.layer-toggle input')].filter((i) => !i.checked);
        const el = inputs.find((i) => i.getClientRects().length > 0) ?? inputs[0] ?? null;
        window.__wmLayerEl = el;
        return el;
      });
      const el = handle.asElement();
      if (!el) throw new Error('no unchecked layer toggle');
      await el.click({ timeout: RESULT_TIMEOUT_MS, force: true });
    },
    done: () => window.__wmLayerEl?.checked === true,
  },
  panel: {
    // Panels render their tabs lazily, so the tabbed panel is scrolled into
    // view first. That wait is setup and is not part of the measured interval.
    async prepare(page) {
      await page.evaluate((id) => document.querySelector(`#panelsGrid .panel[data-panel="${id}"]`)?.scrollIntoView(), TABBED_PANEL);
      await page.waitForSelector(`#panelsGrid .panel[data-panel="${TABBED_PANEL}"] .panel-tab:not(.active)`, { timeout: RESULT_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
    },
    async act(page) {
      const handle = await page.evaluateHandle((id) => {
        const tabs = [...document.querySelectorAll(`#panelsGrid .panel[data-panel="${id}"] .panel-tab`)]
          .filter((t) => !t.classList.contains('active') && t.getClientRects().length > 0);
        window.__wmTabEl = tabs[0] ?? null;
        return window.__wmTabEl;
      }, TABBED_PANEL);
      const el = handle.asElement();
      if (!el) throw new Error('no inactive panel tab');
      await el.click({ timeout: RESULT_TIMEOUT_MS });
    },
    done: () => {
      const t = window.__wmTabEl;
      const on = t && (t.classList.contains('active') || t.getAttribute('aria-checked') === 'true');
      const body = t?.closest('.panel')?.querySelector('.panel-content');
      return !!on && !!body && body.getClientRects().length > 0 && body.textContent.trim().length > 0;
    },
  },
  search: {
    async act(page) {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
      await page.waitForSelector('.search-overlay .search-input', { timeout: RESULT_TIMEOUT_MS });
      await page.keyboard.type('korea');
    },
    done: () => {
      const input = document.querySelector('.search-overlay .search-input');
      const items = document.querySelectorAll('.search-overlay .search-result-item[data-index]');
      return input?.value === 'korea' && items.length > 0 && items[0].getClientRects().length > 0;
    },
  },
};

async function measureInteraction(browser, cpu, env, name) {
  const { context, page, cdp } = await newSession(browser, cpu, env);
  try {
    await openDashboard(page, cdp);
    await page.waitForTimeout(SETTLE_MS);
    const def = INTERACTION_DEFS[name];
    if (def.prepare) await def.prepare(page);
    await page.evaluate(() => { window.__wmT0 = null; window.__wmArm = true; window.__wmPerf.event.length = 0; });
    // Start the result poller before the input so the input time and the
    // result time come from one clock.
    const resultP = page.evaluate(({ src, limit }) => new Promise((resolve) => {
      const done = new Function(`return (${src})()`);
      const start = performance.now();
      const tick = () => {
        if (window.__wmT0 !== null && done()) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__wmT0)));
        } else if (performance.now() - start > limit + 5000) resolve(null);
        else requestAnimationFrame(tick);
      };
      tick();
    }), { src: def.done.toString(), limit: RESULT_TIMEOUT_MS }).catch(() => null);
    await def.act(page);
    const visibleMs = await resultP;
    if (visibleMs == null || visibleMs > RESULT_TIMEOUT_MS) return { inputToPaint: null, resultVisible: null };
    await page.waitForTimeout(300);
    const events = await page.evaluate(() => {
      for (const { o, bucket } of window.__wmObservers) {
        for (const e of o.takeRecords()) window.__wmPerf[bucket].push({ name: e.name, startTime: e.startTime, duration: e.duration });
      }
      return { t0: window.__wmT0, entries: window.__wmPerf.event };
    });
    // Event Timing only reports interactions slower than the threshold; an
    // interaction with no entry took at most that long.
    const mine = events.entries.filter((e) => e.startTime >= events.t0 - 1);
    const inputToPaint = mine.length ? Math.max(...mine.map((e) => e.duration)) : EVENT_THRESHOLD_MS;
    return { inputToPaint, resultVisible: visibleMs };
  } catch (err) {
    console.error(`  ${name} failed: ${String(err.message).split('\n')[0]}`);
    return { inputToPaint: null, resultVisible: null };
  } finally {
    await context.close();
  }
}

export async function measure({ label, runs, cpu }) {
  loadEnvFile(import.meta.url);
  const env = process.env;
  if (!env.WM_PERSONAL_PASSWORD) throw new Error('WM_PERSONAL_PASSWORD is not set in .env.local');
  const { chromium } = await import('playwright');
  const names = [
    ...[...LOAD_METRICS, ...COLD_ONLY_METRICS].map((m) => `cold.${m}`),
    ...LOAD_METRICS.map((m) => `warm.${m}`),
    ...INTERACTIONS.flatMap((n) => [`${n}.inputToPaint`, `${n}.resultVisible`]),
  ];
  const samples = Object.fromEntries(names.map((n) => [n, []]));
  const record = (prefix, values, keys) => {
    for (const k of keys) {
      const v = values?.[k];
      samples[`${prefix}.${k}`].push(typeof v === 'number' && Number.isFinite(v) ? v : null);
    }
  };

  // Headless Chromium defaults to SwiftShader, which the app rejects for DeckGL
  // and answers with the SVG map. Ask for the real GPU so the desktop path is measured.
  const gpuArgs = process.platform === 'win32'
    ? ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu']
    : ['--ignore-gpu-blocklist', '--enable-gpu'];
  const browser = await chromium.launch({ headless: true, args: gpuArgs });
  try {
    for (let run = 1; run <= runs; run++) {
      console.log(`run ${run}/${runs}`);
      let cold = null;
      let warm = null;
      const s = await newSession(browser, cpu, env);
      try {
        cold = await openDashboard(s.page, s.cdp);
        warm = await openDashboard(s.page, s.cdp);
      } catch (err) {
        console.error(`  load failed: ${String(err.message).split('\n')[0]}`);
      } finally {
        await s.context.close();
      }
      record('cold', cold, [...LOAD_METRICS, ...COLD_ONLY_METRICS]);
      record('warm', warm, LOAD_METRICS);
      for (const name of INTERACTIONS) {
        record(name, await measureInteraction(browser, cpu, env, name), ['inputToPaint', 'resultVisible']);
      }
    }
  } finally {
    await browser.close();
  }

  const metrics = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, summarize(v)]));
  const report = {
    label,
    createdAt: new Date().toISOString(),
    config: { runs, cpu, viewport: VIEWPORT, url: BASE_URL, eventThresholdMs: EVENT_THRESHOLD_MS },
    metrics,
  };
  mkdirSync(PERF_DIR, { recursive: true });
  writeFileSync(join(PERF_DIR, `${label}.json`), `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

const fmt = (v) => (v == null ? '-' : Number(v).toFixed(1));

function printReport(report) {
  let failedTotal = 0;
  for (const [metric, s] of Object.entries(report.metrics)) {
    failedTotal += s.failed;
    console.log(`${metric.padEnd(28)} median ${fmt(s.median).padStart(10)}  min ${fmt(s.min).padStart(10)}  max ${fmt(s.max).padStart(10)}  failed ${s.failed}/${s.runs}`);
  }
  console.log(`failed measurements: ${failedTotal}`);
}

function printComparison(a, b) {
  console.log(`${a.label} -> ${b.label}`);
  for (const r of compareReports(a, b)) {
    const change = r.changePct == null ? '-' : `${r.changePct > 0 ? '+' : ''}${r.changePct}%`;
    console.log(`${r.metric.padEnd(28)} ${fmt(r.before.median).padStart(10)} -> ${fmt(r.after.median).padStart(10)}  ${change.padStart(8)}  improved: ${r.improved ? 'yes' : 'no'}${r.after.failed ? '  (failed runs)' : ''}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.mode === 'compare') {
    const read = (l) => JSON.parse(readFileSync(join(PERF_DIR, `${l}.json`), 'utf8'));
    printComparison(read(args.compare[0]), read(args.compare[1]));
    return;
  }
  printReport(await measure(args));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err.message); process.exit(1); });
}
