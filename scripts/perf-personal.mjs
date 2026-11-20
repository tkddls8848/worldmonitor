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
// panelsReady looks at the first PANELS_READY_COUNT data panels in layout order.
// These never leave the first-screen set empty or never settle, so they are skipped.
const PANELS_READY_COUNT = 6;
const EXCLUDED_PANELS = {
  'live-news': 'video panel, never shows a loading state',
  'live-webcams': 'video panel, never shows a loading state',
  forecast: 'stays in its loading state indefinitely in the personal setup (no data source)',
};
// src/components/SearchModal.ts SEARCH_DEBOUNCE_MS
const SEARCH_DEBOUNCE_MS = 180;

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
  // Heavy dashboard: ~270 JS chunks plus API calls overflow the default 250-entry buffer.
  try { performance.setResourceTimingBufferSize(5000); } catch { /* ignore */ }
  // Opt into the app's own render-milestone marks (src/utils/lcp-debug.ts).
  window.__wmLcpDebug = { enabled: true, marks: [] };
  // Count WebGL draw calls: the only map-side redraw signal that needs no app change.
  window.__wmDraws = 0;
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const orig = C.prototype[m];
      if (!orig) continue;
      C.prototype[m] = function patched(...args) { window.__wmDraws++; return orig.apply(this, args); };
    }
  }
  window.__wmPerf = { paint: [], lcp: [], longtask: [], event: [], eventAttached: false };
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
      return true;
    } catch { return false; /* entry type unsupported */ }
  };
  observe('paint', 'paint');
  observe('largest-contentful-paint', 'lcp');
  observe('longtask', 'longtask');
  window.__wmPerf.eventAttached = observe('event', 'event', { durationThreshold: threshold });
  // Input time on the performance.now() clock. __wmFirst is the first armed
  // input; __wmT0 is the first too, or the last one when __wmArmMode is 'last'.
  window.__wmFirst = null;
  window.__wmT0 = null;
  window.__wmArm = false;
  window.__wmArmMode = 'first';
  const stamp = (e) => {
    if (!window.__wmArm) return;
    if (window.__wmFirst === null) { window.__wmFirst = e.timeStamp; window.__wmDrawsAtFirst = window.__wmDraws; }
    if (window.__wmArmMode === 'last' || window.__wmT0 === null) window.__wmT0 = e.timeStamp;
  };
  addEventListener('pointerdown', stamp, true);
  addEventListener('keydown', stamp, true);
  // Record why a page navigated (an app-initiated reload shows up here).
  try {
    navigation.addEventListener('navigate', (e) => {
      if (e.destination.sameDocument) return;
      console.log(`__wm_nav ${e.navigationType} ${new URL(e.destination.url).pathname} ${String(new Error().stack).split('\n').slice(2, 5).join(' | ')}`);
    });
  } catch { /* Navigation API unavailable */ }
}

// The three load waits run in the page and resolve with performance.now().
// mapReady: the app's deck-ready mark (MapLibre constructed), the deck overlay
// attached (that happens in the MapLibre 'load' handler, after the style loaded),
// and then a WebGL draw after that, followed by a painted frame.
function waitMapReady() {
  return new Promise((resolve) => {
    let drawsAtOverlay = null;
    const tick = () => {
      const deckReady = window.__wmLcpDebug.marks.some((m) => m.name === 'wm:map:deck-ready');
      const overlay = document.querySelector('#mapContainer.deckgl-mode .maplibregl-canvas-container.deck-widget-container');
      if (deckReady && overlay && drawsAtOverlay === null) drawsAtOverlay = window.__wmDraws;
      if (drawsAtOverlay !== null && window.__wmDraws > drawsAtOverlay) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now())));
      } else requestAnimationFrame(tick);
    };
    tick();
  });
}

// panelsReady: the first `count` data panels in layout order, wherever the
// fold is. A panel is settled when it shows no loading indicator; rendered data
// and an error state both count. Waits until all `count` panels exist.
function waitPanelsReady({ excluded, count }) {
  return new Promise((resolve) => {
    let stable = 0;
    const tick = () => {
      const panels = [...document.querySelectorAll('#panelsGrid .panel')]
        .filter((p) => p.getClientRects().length > 0 && !excluded.includes(p.dataset.panel))
        .slice(0, count);
      const state = (p) => (p.querySelector('.panel-error-radar') ? 'error'
        : p.querySelector('.panel-loading, .panel-loading-radar') ? 'loading' : 'ready');
      const states = panels.map(state);
      if (panels.length === count && !states.includes('loading')) stable++; else stable = 0;
      // Two consecutive clean frames, so a panel that is about to re-render is not missed.
      if (stable >= 2) {
        resolve({
          t: performance.now(),
          panels: panels.map((p) => p.dataset.panel),
          errored: panels.filter((_, i) => states[i] === 'error').map((p) => p.dataset.panel),
        });
      } else requestAnimationFrame(tick);
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
  const [mapReady, panelsRes] = await Promise.all([
    withTimeout(page.evaluate(waitMapReady), LOAD_TIMEOUT_MS, 'map never became ready'),
    withTimeout(page.evaluate(waitPanelsReady, { excluded: Object.keys(EXCLUDED_PANELS), count: PANELS_READY_COUNT }),
      LOAD_TIMEOUT_MS, 'first data panels never finished loading'),
  ]);
  const panelsReady = panelsRes.t;
  const data = await page.evaluate(() => {
    const p = window.__wmPerf;
    const fcp = p.paint.find((e) => e.name === 'first-contentful-paint')?.startTime ?? null;
    const lcp = p.lcp.length ? p.lcp[p.lcp.length - 1].startTime : null;
    const res = performance.getEntriesByType('resource');
    const bytes = (re) => res.filter((r) => re.test(new URL(r.name).pathname)).reduce((s, r) => s + r.transferSize, 0);
    return { fcp, lcp, longtasks: p.longtask, jsBytes: bytes(/\.m?js$/), cssBytes: bytes(/\.css$/), resources: res.length };
  });
  const heap = (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? null;
  // Long tasks from first paint until both the map and the first panels are ready.
  const windowEnd = Math.max(mapReady, panelsReady);
  const tbt = data.fcp == null ? null : data.longtasks
    .filter((t) => t.startTime >= data.fcp && t.startTime <= windowEnd)
    .reduce((s, t) => s + Math.max(0, t.duration - 50), 0);
  return {
    fcp: data.fcp, lcp: data.lcp, mapReady, panelsReady, tbt,
    jsBytes: data.jsBytes, cssBytes: data.cssBytes,
    heapMB: heap == null ? null : heap / (1024 * 1024),
    panels: panelsRes.panels, erroredPanels: panelsRes.errored,
  };
}

async function newSession(browser, cpu, env) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    httpCredentials: { username: env.WM_PERSONAL_USERNAME || 'owner', password: env.WM_PERSONAL_PASSWORD || '' },
  });
  await context.addInitScript(initScript, EVENT_THRESHOLD_MS);
  const page = await context.newPage();
  // Kept for failure diagnosis: why the page navigated and what it logged.
  const diag = { navigations: [], consoleErrors: [] };
  page.on('console', (m) => {
    const text = m.text();
    if (text.startsWith('__wm_nav ')) diag.navigations.push(text.slice(9, 400));
    else if (m.type() === 'error') diag.consoleErrors.push(text.slice(0, 200));
  });
  page.on('pageerror', (e) => diag.consoleErrors.push(`pageerror: ${String(e.message).slice(0, 200)}`));
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  if (cpu > 1) await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  return { context, page, cdp, diag };
}

function failureRecord(what, err, diag) {
  return {
    what,
    error: String(err?.message ?? err).split('\n')[0],
    navigations: diag.navigations.slice(-3),
    consoleErrors: diag.consoleErrors.slice(-5),
  };
}

// Per-interaction: how to trigger it (`act`) and how the page recognises the
// result (`done`, evaluated in the page once per frame). `armMode` decides
// which input stamps t0: the first armed input, or the last one.
const LAYER = 'cables';
const INTERACTION_DEFS = {
  country: {
    async act(page) { await page.locator('.cii-country').first().click({ timeout: RESULT_TIMEOUT_MS }); },
    done: () => {
      const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
      return vis(document.querySelector('.country-brief-overlay')) || vis(document.querySelector('#country-deep-dive-panel'));
    },
  },
  layer: {
    // `cables` is static data with no zoom gate, so it draws at the default view.
    // Done: the checkbox is on, the app recorded the layer in the URL state, and
    // the map issued WebGL draws after the input (deck re-rendered with the layer).
    async act(page, args) {
      const handle = await page.evaluateHandle((layer) => {
        const el = document.querySelector(`.layer-toggle[data-layer="${layer}"] input`);
        window.__wmLayerEl = el && !el.checked ? el : null;
        return window.__wmLayerEl;
      }, args.layer);
      const el = handle.asElement();
      if (!el) throw new Error(`layer toggle ${args.layer} missing or already on`);
      await el.click({ timeout: RESULT_TIMEOUT_MS, force: true });
    },
    done: (args) => {
      const layers = (new URL(location.href).searchParams.get('layers') ?? '').split(',');
      return window.__wmLayerEl?.checked === true && layers.includes(args.layer) && window.__wmDraws > window.__wmDrawsAtFirst;
    },
  },
  panel: {
    // Panels render their tabs lazily, so the tabbed panel is scrolled into
    // view first. That wait is setup and is not part of the measured interval.
    async prepare(page) {
      await page.evaluate((id) => document.querySelector(`#panelsGrid .panel[data-panel="${id}"]`)?.scrollIntoView(), TABBED_PANEL);
      await page.waitForSelector(`#panelsGrid .panel[data-panel="${TABBED_PANEL}"] .panel-tab:not(.active)`, { timeout: RESULT_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
    },
    // Done: the tab is active, the panel shows neither the loading nor the error
    // state, and its content differs from what it held before the click.
    async act(page) {
      const handle = await page.evaluateHandle((id) => {
        const panel = document.querySelector(`#panelsGrid .panel[data-panel="${id}"]`);
        const tabs = [...panel.querySelectorAll('.panel-tab')].filter((t) => !t.classList.contains('active') && t.getClientRects().length > 0);
        window.__wmTabEl = tabs[0] ?? null;
        window.__wmPanelEl = panel;
        window.__wmPanelSnap = panel.querySelector('.panel-content')?.innerHTML ?? '';
        return window.__wmTabEl;
      }, TABBED_PANEL);
      const el = handle.asElement();
      if (!el) throw new Error('no inactive panel tab');
      await el.click({ timeout: RESULT_TIMEOUT_MS });
    },
    done: () => {
      const t = window.__wmTabEl;
      const panel = window.__wmPanelEl;
      const body = panel?.querySelector('.panel-content');
      if (!t || !body || !t.classList.contains('active')) return false;
      if (panel.querySelector('.panel-loading, .panel-loading-radar, .panel-error-radar')) return false;
      return body.getClientRects().length > 0 && body.innerHTML !== window.__wmPanelSnap;
    },
  },
  search: {
    // Every armed key stamps t0, so t0 ends up on the last keystroke of "korea";
    // the first (Ctrl+K) stamps __wmFirst, so inputToPaint still covers opening.
    // Done: the input holds "korea" and the result list rendered at least one
    // debounce after that last key, so a partial-query render cannot satisfy it.
    armMode: 'last',
    async act(page) {
      await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
      await page.waitForSelector('.search-overlay .search-results', { timeout: RESULT_TIMEOUT_MS });
      await page.evaluate(() => {
        window.__wmResultMutations = [];
        new MutationObserver(() => window.__wmResultMutations.push(performance.now()))
          .observe(document.querySelector('.search-overlay .search-results'), { childList: true, subtree: true });
      });
      await page.keyboard.type('korea');
    },
    done: (args) => {
      const input = document.querySelector('.search-overlay .search-input');
      const items = document.querySelectorAll('.search-overlay .search-result-item[data-index]');
      return input?.value === 'korea' && items.length > 0 && items[0].getClientRects().length > 0
        && window.__wmResultMutations.some((t) => t >= window.__wmT0 + args.debounceMs);
    },
  },
};

async function measureInteraction(browser, cpu, env, name) {
  const { context, page, cdp, diag } = await newSession(browser, cpu, env);
  try {
    await openDashboard(page, cdp);
    await page.waitForTimeout(SETTLE_MS);
    const def = INTERACTION_DEFS[name];
    if (def.prepare) await def.prepare(page);
    await page.evaluate((mode) => {
      window.__wmFirst = null; window.__wmT0 = null; window.__wmArm = true; window.__wmArmMode = mode;
      window.__wmPerf.event.length = 0;
    }, def.armMode ?? 'first');
    const args = { layer: LAYER, debounceMs: SEARCH_DEBOUNCE_MS };
    // Start the result poller before the input so the input time and the
    // result time come from one clock.
    const resultP = page.evaluate(({ src, limit, args: a }) => new Promise((resolve) => {
      const done = new Function('args', `return (${src})(args)`);
      const start = performance.now();
      const tick = () => {
        if (window.__wmT0 !== null && done(a)) {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(performance.now() - window.__wmT0)));
        } else if (performance.now() - start > limit + 5000) resolve(null);
        else requestAnimationFrame(tick);
      };
      tick();
    }), { src: def.done.toString(), limit: RESULT_TIMEOUT_MS, args }).catch(() => null);
    await def.act(page, args);
    const visibleMs = await resultP;
    if (visibleMs == null || visibleMs > RESULT_TIMEOUT_MS) {
      return { inputToPaint: null, resultVisible: null, failure: failureRecord(name, 'result not visible within 15s', diag) };
    }
    await page.waitForTimeout(300);
    const events = await page.evaluate(() => {
      for (const { o, bucket } of window.__wmObservers) {
        for (const e of o.takeRecords()) window.__wmPerf[bucket].push({ name: e.name, startTime: e.startTime, duration: e.duration });
      }
      return { first: window.__wmFirst, attached: window.__wmPerf.eventAttached, entries: window.__wmPerf.event };
    });
    // A page whose Event Timing observer never attached has no data at all: null.
    // With the observer attached, no entry means the interaction took under the
    // threshold, so the threshold is the value (read it as "<16ms").
    let inputToPaint = null;
    if (events.attached) {
      const mine = events.entries.filter((e) => e.startTime >= events.first - 1);
      inputToPaint = mine.length ? Math.max(...mine.map((e) => e.duration)) : EVENT_THRESHOLD_MS;
    }
    return { inputToPaint, resultVisible: visibleMs, failure: events.attached ? null : failureRecord(name, 'event observer not attached', diag) };
  } catch (err) {
    console.error(`  ${name} failed: ${String(err.message).split('\n')[0]}`);
    return { inputToPaint: null, resultVisible: null, failure: failureRecord(name, err, diag) };
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
  const failures = [];
  const panelsUsed = new Set();
  const erroredRuns = {};
  const notePanels = (r) => {
    for (const id of r?.panels ?? []) panelsUsed.add(id);
    for (const id of r?.erroredPanels ?? []) erroredRuns[id] = (erroredRuns[id] ?? 0) + 1;
  };
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
        failures.push({ run, ...failureRecord('load', err, s.diag) });
      } finally {
        await s.context.close();
      }
      notePanels(cold);
      notePanels(warm);
      record('cold', cold, [...LOAD_METRICS, ...COLD_ONLY_METRICS]);
      record('warm', warm, LOAD_METRICS);
      for (const name of INTERACTIONS) {
        const r = await measureInteraction(browser, cpu, env, name);
        if (r.failure) failures.push({ run, ...r.failure });
        record(name, r, ['inputToPaint', 'resultVisible']);
      }
    }
  } finally {
    await browser.close();
  }

  const metrics = Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, summarize(v)]));
  const report = {
    label,
    createdAt: new Date().toISOString(),
    config: {
      runs, cpu, viewport: VIEWPORT, url: BASE_URL,
      // inputToPaint is EVENT_THRESHOLD_MS when the observer saw nothing: read as "<16ms".
      eventThresholdMs: EVENT_THRESHOLD_MS,
      panelsReady: { count: PANELS_READY_COUNT, excluded: EXCLUDED_PANELS, used: [...panelsUsed], erroredRuns },
      layer: LAYER, tabbedPanel: TABBED_PANEL,
    },
    metrics,
    failures,
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
  for (const f of report.failures ?? []) console.log(`  run ${f.run} ${f.what}: ${f.error}${f.navigations.length ? ` [nav: ${f.navigations.join(' ; ')}]` : ''}`);
  const errored = report.config.panelsReady.erroredRuns;
  if (Object.keys(errored).length) console.log(`panels that ended in an error state (runs): ${JSON.stringify(errored)}`);
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
