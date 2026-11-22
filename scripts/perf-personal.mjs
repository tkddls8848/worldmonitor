// Frontend performance runner for the personal dashboard. See USAGE below
// (`npm run perf:personal -- --help`). A measurement that cannot be taken is
// recorded as null (failed); it is never turned into 0 and never skipped.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadEnvFile } from './_env-file.mjs';
import { compareReports, summarize, summarizeOptional, unmatchedMetrics } from './perf/perf-stats.mjs';

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

// mapReady is split at the app's renderer-demand mark (src/components/MapContainer.ts):
// mapDemand is when the deliberate visible-idle gate released the DeckGL load,
// mapAfterDemand is mapReady minus mapDemand (chunk load, style, deck, first draw).
export const LOAD_METRICS = ['fcp', 'lcp', 'mapReady', 'mapDemand', 'mapAfterDemand', 'worldReady', 'panelsReady', 'tbt'];
export const COLD_ONLY_METRICS = ['jsBytes', 'cssBytes', 'heapMB'];
export const INTERACTIONS = ['country', 'layer', 'panel', 'search'];
export const METRIC_NAMES = [
  ...[...LOAD_METRICS, ...COLD_ONLY_METRICS].map((m) => `cold.${m}`),
  ...LOAD_METRICS.map((m) => `warm.${m}`),
  ...INTERACTIONS.flatMap((n) => [`${n}.inputToPaint`, `${n}.resultVisible`]),
];

export const USAGE = `Usage:
  npm run perf:personal -- --label <name> [--runs 5] [--cpu 1|4] [--warmup 1]
  npm run perf:personal -- --compare <labelA> <labelB>

Measures the running personal server (WM_PERF_URL, default http://127.0.0.1:3000;
WM_PERF_FIRST_SCREEN=full|world pins the dashboard first screen)
and writes .personal/perf/<label>.json.

  --label <name>   report name, ^[a-z0-9-]+$
  --runs <n>       measured runs (default 5). Each run: cold and warm load,
                   then the country, layer, panel and search interactions.
  --cpu <n>        CPU throttling rate (default 1, no throttling)
  --warmup <n>     full runs made first and discarded (default 1), so the
                   first server-cold run does not land in the samples
  --compare a b    print the median change between two saved reports

The report keeps each metric's summary (median, min, max, failed) under
"metrics" and the raw per-run samples (null = failed) under "samples".`;

export function parseArgs(argv) {
  let label;
  let runs = 5;
  let cpu = 1;
  let warmup = 1;
  let compare;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { mode: 'help' };
    if (arg === '--label') label = argv[++i];
    else if (arg === '--runs') runs = Number(argv[++i]);
    else if (arg === '--cpu') cpu = Number(argv[++i]);
    else if (arg === '--warmup') warmup = Number(argv[++i]);
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
  if (!Number.isInteger(warmup) || warmup < 0) throw new Error('--warmup must be a non-negative integer');
  return { mode: 'measure', label, runs, cpu, warmup };
}

// Runs in every page before any script: collects the timing entries.
function initScript(threshold) {
  // Heavy dashboard: ~270 JS chunks plus API calls overflow the default 250-entry buffer.
  try { performance.setResourceTimingBufferSize(5000); } catch { /* ignore */ }
  // Opt into the app's own render-milestone marks and its deck layer commits
  // (src/utils/lcp-debug.ts).
  window.__wmLcpDebug = { enabled: true, marks: [] };
  // Count WebGL draw calls (the map's redraw signal). While an interaction is
  // armed, also keep the time of the last draw, so a draw can be ordered
  // against the app's deck layer commit (__wmLcpDebug.deckLayers.at).
  window.__wmDraws = 0;
  window.__wmLastDrawAt = null;
  for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {
    if (!C) continue;
    for (const m of ['drawArrays', 'drawElements', 'drawArraysInstanced', 'drawElementsInstanced', 'drawRangeElements']) {
      const orig = C.prototype[m];
      if (!orig) continue;
      C.prototype[m] = function patched(...args) {
        window.__wmDraws++;
        if (window.__wmArm) window.__wmLastDrawAt = performance.now();
        return orig.apply(this, args);
      };
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
    if (window.__wmFirst === null) window.__wmFirst = e.timeStamp;
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

// The load waits run in the page and resolve with performance.now() times.
// mapReady: the app's deck-ready mark (MapLibre constructed), the deck overlay
// attached (that happens in the MapLibre 'load' handler, after the style loaded),
// and then a WebGL draw after that, followed by a painted frame.
// demandAt: the app's renderer-demand mark, the end of the deliberate gate that
// holds the DeckGL load back after first paint. Read while polling, because the
// app keeps only its latest marks.
function waitMapReady() {
  return new Promise((resolve) => {
    let drawsAtOverlay = null;
    let demandAt = null;
    const tick = () => {
      const marks = window.__wmLcpDebug.marks;
      if (demandAt === null) demandAt = marks.find((m) => m.name === 'wm:map:renderer-demand')?.startTime ?? null;
      const deckReady = marks.some((m) => m.name === 'wm:map:deck-ready');
      const overlay = document.querySelector('#mapContainer.deckgl-mode .maplibregl-canvas-container.deck-widget-container');
      if (deckReady && overlay && drawsAtOverlay === null) drawsAtOverlay = window.__wmDraws;
      if (drawsAtOverlay !== null && window.__wmDraws > drawsAtOverlay) {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve({ t: performance.now(), demandAt })));
      } else requestAnimationFrame(tick);
    };
    tick();
  });
}

// panelsReady: the first `count` data panels in layout order, wherever the
// fold is. A panel is settled when it shows no loading indicator; rendered data
// and an error state both count. If the mode doesn't mount panels, this is N/A.
function waitPanelsReady({ excluded, count }) {
  return new Promise((resolve) => {
    let stable = 0;
    const tick = () => {
      // World first screen: the full view (and its hidden, empty grid) is not built.
      if (document.documentElement.classList.contains('wm-world-mode')) { resolve(null); return; }
      const grid = document.querySelector('#panelsGrid');
      if (!grid) {
        if (document.querySelector('.wfs-root')) { resolve(null); return; }
        requestAnimationFrame(tick);
        return;
      }
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

function waitWorldReady() {
  return new Promise((resolve) => {
    const tick = () => {
      if (!document.querySelector('.wfs-root')) {
        if (document.querySelector('#panelsGrid')) { resolve(null); return; }
        requestAnimationFrame(tick);
        return;
      }
      const mark = window.__wmLcpDebug.marks.find((m) => m.name === 'wm:world:first-draw');
      if (mark) resolve(mark.startTime);
      else requestAnimationFrame(tick);
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
  const [mapRes, panelsRes, worldReady] = await Promise.all([
    withTimeout(page.evaluate(waitMapReady), LOAD_TIMEOUT_MS, 'map never became ready'),
    withTimeout(page.evaluate(waitPanelsReady, { excluded: Object.keys(EXCLUDED_PANELS), count: PANELS_READY_COUNT }),
      LOAD_TIMEOUT_MS, 'first data panels never finished loading'),
    withTimeout(page.evaluate(waitWorldReady), LOAD_TIMEOUT_MS, 'world first draw mark never arrived'),
  ]);
  const mapReady = mapRes.t;
  const mapDemand = mapRes.demandAt;
  const panelsReady = panelsRes?.t ?? null;
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
  const windowEnd = Math.max(mapReady, panelsReady ?? mapReady);
  const tbt = data.fcp == null ? null : data.longtasks
    .filter((t) => t.startTime >= data.fcp && t.startTime <= windowEnd)
    .reduce((s, t) => s + Math.max(0, t.duration - 50), 0);
  return {
    fcp: data.fcp, lcp: data.lcp, mapReady, mapDemand, worldReady,
    mapAfterDemand: mapDemand == null ? null : mapReady - mapDemand,
    panelsReady, tbt,
    jsBytes: data.jsBytes, cssBytes: data.cssBytes,
    heapMB: heap == null ? null : heap / (1024 * 1024),
    panels: panelsRes?.panels ?? [], erroredPanels: panelsRes?.errored ?? [],
  };
}

async function newSession(browser, cpu, env) {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    httpCredentials: { username: env.WM_PERSONAL_USERNAME || 'owner', password: env.WM_PERSONAL_PASSWORD || '' },
  });
  await context.addInitScript(initScript, EVENT_THRESHOLD_MS);
  // WM_PERF_FIRST_SCREEN=full|world pins the /dashboard first screen (the
  // app's saved choice) so the old full view can be measured as a baseline.
  const firstScreen = env.WM_PERF_FIRST_SCREEN;
  if (firstScreen === 'full' || firstScreen === 'world') {
    await context.addInitScript((mode) => {
      try { localStorage.setItem('worldmonitor-first-screen-mode', JSON.stringify(mode)); } catch { /* private mode */ }
    }, firstScreen);
  }
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

/**
 * The layer interaction's result, evaluated in the page once per frame: the
 * checkbox is on, the app committed a deck layer list holding the toggled layer
 * after the input (src/utils/lcp-debug.ts recordDeckLayersDebug), and the map
 * issued a WebGL draw after that commit. Self-contained, because it is
 * serialised into the page; `w` is the page window and is injectable for tests.
 */
export function layerDrawn(args, w = window) {
  const committed = w.__wmLcpDebug?.deckLayers;
  return w.__wmLayerEl?.checked === true
    && committed != null
    && typeof w.__wmT0 === 'number' && committed.at >= w.__wmT0
    && Array.isArray(committed.ids) && committed.ids.includes(args.deckLayerId)
    && typeof w.__wmLastDrawAt === 'number' && w.__wmLastDrawAt > committed.at;
}

export function countryResultVisible(args, w = window) {
  if (args.worldMode) return w.document.querySelector('.wfs-country-drawer[data-state="open"]') != null;
  const vis = (el) => !!el && el.getClientRects().length > 0 && w.getComputedStyle(el).visibility !== 'hidden';
  return vis(w.document.querySelector('.country-brief-overlay')) || vis(w.document.querySelector('#country-deep-dive-panel'));
}

// Per-interaction: how to trigger it (`act`) and how the page recognises the
// result (`done`, evaluated in the page once per frame). `armMode` decides
// which input stamps t0: the first armed input, or the last one.
const LAYER = 'cables';
// DeckGLMap's id for that layer (createCablesLayer).
const LAYER_DECK_ID = 'cables-layer';
const INTERACTION_DEFS = {
  country: {
    async act(page, args) {
      if (args.worldMode) {
        const canvas = page.locator('#mapContainer canvas.maplibregl-canvas, #mapContainer canvas').first();
        const box = await canvas.boundingBox();
        if (!box) throw new Error('world map canvas is not visible');
        await page.mouse.click(box.x + box.width * 0.57, box.y + box.height * 0.47);
      } else {
        await page.locator('.cii-country').first().click({ timeout: RESULT_TIMEOUT_MS });
      }
    },
    done: countryResultVisible,
  },
  layer: {
    // `cables` is static data with no zoom gate, so it draws at the default view.
    // The layers drawer and its group accordion start collapsed in Option B, so
    // expand them outside the measured interval before clicking the toggle.
    async prepare(page) {
      await page.evaluate((layer) => {
        const drawer = document.querySelector('#mapContainer .layer-toggles');
        if (drawer?.classList.contains('map-control-collapsed')) {
          const btn = drawer.querySelector('.map-control-toggle, .layer-toggle-header, button[aria-expanded="false"]');
          if (btn instanceof HTMLElement) btn.click();
        }
        const toggle = document.querySelector(`.layer-toggle[data-layer="${layer}"]`);
        const group = toggle?.closest('details.layer-group');
        if (group && !group.open) group.open = true;
      }, LAYER);
      await page.waitForSelector(`.layer-toggle[data-layer="${LAYER}"] input`, { state: 'visible', timeout: RESULT_TIMEOUT_MS });
      await page.waitForTimeout(SETTLE_MS);
    },
    // Done: layerDrawn. The `layers` URL state is not used: the app writes it on
    // a 250 ms debounce (src/app/event-handlers.ts debouncedUrlSync), long after
    // the map has drawn the layer.
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
    done: layerDrawn,
  },
  panel: {
    // Panels render their tabs lazily, and gdelt-intel lives in the Security
    // inspector tab. Switch to Security and scroll it into view outside the
    // measured interval so only the panel-tab click is timed.
    async prepare(page) {
      const secTab = page.locator('[data-inspector-tab="security"]');
      if (await secTab.isVisible().catch(() => false)) {
        await secTab.click();
      }
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
    // The world first screen has no panel grid or layer list; those interactions belong to the full view.
    if ((name === 'panel' || name === 'layer') && await page.evaluate(() => document.documentElement.classList.contains('wm-world-mode'))) {
      return { inputToPaint: null, resultVisible: null, failure: null };
    }
    if (def.prepare) await def.prepare(page);
    const worldMode = await page.locator('.wfs-root').count() > 0;
    await page.evaluate((mode) => {
      window.__wmFirst = null; window.__wmT0 = null; window.__wmArm = true; window.__wmArmMode = mode;
      window.__wmPerf.event.length = 0;
    }, def.armMode ?? 'first');
    const args = { layer: LAYER, deckLayerId: LAYER_DECK_ID, debounceMs: SEARCH_DEBOUNCE_MS, worldMode };
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

const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * Runs `warmup` discarded runs, then `runs` measured ones, and gathers the raw
 * per-metric samples (null = failed). `measureRun(run)` returns
 * `{ values: { [metric]: number|null }, failures: [], loads: [cold, warm] }`.
 * A warm-up run is called with run 0 and leaves no trace in the result.
 */
export async function collectRuns({ runs, warmup, measureRun, log = console.log }) {
  const samples = Object.fromEntries(METRIC_NAMES.map((n) => [n, []]));
  const failures = [];
  const loads = [];
  for (let i = 1; i <= warmup; i++) {
    log(`warm-up ${i}/${warmup} (discarded)`);
    await measureRun(0);
  }
  for (let run = 1; run <= runs; run++) {
    log(`run ${run}/${runs}`);
    const r = await measureRun(run);
    for (const name of METRIC_NAMES) samples[name].push(finiteOrNull(r.values?.[name]));
    for (const f of r.failures ?? []) failures.push({ run, ...f });
    loads.push(...(r.loads ?? []));
  }
  return { samples, failures, loads };
}

/** The saved report: per-metric summaries plus the raw samples they came from. */
export function buildReport({ label, createdAt, config, samples, failures }) {
  const optional = (name) => /\.(worldReady|panelsReady)$/.test(name) || name.startsWith('panel.');
  // The world first screen has no layer list: a layer metric with no sample at
  // all is unavailable, while a partial miss is still a failed measurement.
  const unavailable = (name, values) => name.startsWith('layer.') && values.every((v) => v === null);
  const metrics = Object.fromEntries(Object.entries(samples).map(([k, v]) => [
    k, optional(k) || unavailable(k, v) ? summarizeOptional(v) : summarize(v),
  ]));
  return { label, createdAt, config, metrics, samples, failures };
}

export async function measure({ label, runs, cpu, warmup = 1 }) {
  loadEnvFile(import.meta.url);
  const env = process.env;
  if (!env.WM_PERSONAL_PASSWORD) throw new Error('WM_PERSONAL_PASSWORD is not set in .env.local');
  const { chromium } = await import('playwright');

  // Headless Chromium defaults to SwiftShader, which the app rejects for DeckGL
  // and answers with the SVG map. Ask for the real GPU so the desktop path is measured.
  const gpuArgs = process.platform === 'win32'
    ? ['--use-angle=d3d11', '--ignore-gpu-blocklist', '--enable-gpu']
    : ['--ignore-gpu-blocklist', '--enable-gpu'];
  const browser = await chromium.launch({ headless: true, args: gpuArgs });

  // One full run: cold and warm load in one context, then each interaction in its own.
  const measureRun = async () => {
    const values = {};
    const failures = [];
    let cold = null;
    let warm = null;
    const s = await newSession(browser, cpu, env);
    try {
      cold = await openDashboard(s.page, s.cdp);
      warm = await openDashboard(s.page, s.cdp);
    } catch (err) {
      console.error(`  load failed: ${String(err.message).split('\n')[0]}`);
      failures.push(failureRecord('load', err, s.diag));
    } finally {
      await s.context.close();
    }
    for (const k of [...LOAD_METRICS, ...COLD_ONLY_METRICS]) values[`cold.${k}`] = cold?.[k];
    for (const k of LOAD_METRICS) values[`warm.${k}`] = warm?.[k];
    for (const name of INTERACTIONS) {
      const r = await measureInteraction(browser, cpu, env, name);
      if (r.failure) failures.push(r.failure);
      values[`${name}.inputToPaint`] = r.inputToPaint;
      values[`${name}.resultVisible`] = r.resultVisible;
    }
    return { values, failures, loads: [cold, warm] };
  };

  let collected;
  try {
    collected = await collectRuns({ runs, warmup, measureRun });
  } finally {
    await browser.close();
  }

  const panelsUsed = new Set();
  const erroredRuns = {};
  for (const r of collected.loads) {
    for (const id of r?.panels ?? []) panelsUsed.add(id);
    for (const id of r?.erroredPanels ?? []) erroredRuns[id] = (erroredRuns[id] ?? 0) + 1;
  }
  const report = buildReport({
    label,
    createdAt: new Date().toISOString(),
    config: {
      runs, cpu, warmupRuns: warmup, viewport: VIEWPORT, url: BASE_URL,
      // inputToPaint is EVENT_THRESHOLD_MS when the observer saw nothing: read as "<16ms".
      eventThresholdMs: EVENT_THRESHOLD_MS,
      panelsReady: { count: PANELS_READY_COUNT, excluded: EXCLUDED_PANELS, used: [...panelsUsed], erroredRuns },
      layer: LAYER, layerDeckId: LAYER_DECK_ID, tabbedPanel: TABBED_PANEL,
    },
    samples: collected.samples,
    failures: collected.failures,
  });
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
  const { onlyA, onlyB } = unmatchedMetrics(a, b);
  if (onlyA.length) console.log(`only in ${a.label}, not compared: ${onlyA.join(', ')}`);
  if (onlyB.length) console.log(`only in ${b.label}, not compared: ${onlyB.join(', ')}`);
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    throw new Error(`${err.message}\n\n${USAGE}`);
  }
  if (args.mode === 'help') {
    console.log(USAGE);
    return;
  }
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
