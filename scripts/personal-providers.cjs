// @notification-source: domain (AIS and OREF)
// In-process data adapters for the single-owner server. No listener or public client fanout.
// Batch datasets belong to personal-collect.mjs; only live AIS/OREF loops run here.
module.exports.createPersonalProviders = function createPersonalProviders(options = {}) {
  const shutdown = new AbortController();
  const fetch = (url, init = {}) => (options.fetch || globalThis.fetch)(url, {
    ...init, signal: init.signal ? AbortSignal.any([init.signal, shutdown.signal]) : shutdown.signal,
  });
  const orefState = {
  lastAlerts: [],
  lastAlertsJson: '[]',
  lastPollAt: 0,
  lastError: null,
  historyCount24h: 0,
  totalHistoryCount: 0,
  history: [],
  bootstrapSource: null,
  _persistVersion: 0,
  _lastPersistedVersion: 0,
  _persistInFlight: false,
  _alertsCache: null,  // { json, gzip, brotli }
  _historyCache: null, // { json, gzip, brotli }
};
  const timers = new Set();
  const setTimeout = (fn, ms, ...args) => {
    const timer = globalThis.setTimeout(() => { timers.delete(timer); if (!relayShuttingDown) fn(...args); }, ms);
    if (relayShuttingDown) globalThis.clearTimeout(timer); else timers.add(timer);
    return timer;
  };
  const setInterval = (fn, ms, ...args) => {
    const timer = globalThis.setInterval(() => { if (!relayShuttingDown) fn(...args); }, ms);
    if (relayShuttingDown) globalThis.clearInterval(timer); else timers.add(timer);
    return timer;
  };
  const clearTimeout = (timer) => { timers.delete(timer); globalThis.clearTimeout(timer); };
  const clearInterval = (timer) => { timers.delete(timer); globalThis.clearInterval(timer); };
const http = require('http');

const https = require('https');

const zlib = require('zlib');

const path = require('path');

const { readFileSync } = require('fs');

const { WebSocket } = require('ws');

const { parseProxyConfig, resolveProxyString, resolveProxyStringForAttempt } = require('./_proxy-utils.cjs');

const {
  cooldownKeyForAccount,
  OPENSKY_LEGACY_COOLDOWN_KEY,
  OPENSKY_MAX_COOLDOWN_MS,
  OPENSKY_SHARED_FALLBACK_COOLDOWN_MS,
  OPENSKY_MAX_DEADLINE_SET_LUA,
  accountFingerprint: openSkyAccountFingerprint,
  clampCooldownMs,
  ttlSecondsForCooldown,
  inspectCooldownRecord,
  buildCooldownRecord,
  maxDeadlineSetCommand,
  legacyCooldownCompatibilityEnabled,
} = require('./_opensky-account-cooldown.cjs');

const OPENSKY_ACCOUNT_FINGERPRINT = openSkyAccountFingerprint(process.env.OPENSKY_CLIENT_ID);

const OPENSKY_COOLDOWN_KEY = cooldownKeyForAccount(OPENSKY_ACCOUNT_FINGERPRINT);

const { createGuardedLookup, SSRF_BLOCKED_ERROR_CODE } = require('./lib/notification-webhook-ssrf.cjs');

// API fan-out of rss_alert / market_alert queue messages (news.breaking,
// market.move). The webhook worker that drained it was removed; the list is
// capped and expires on its own.
const {
  API_FANOUT_EVENT_TYPES,
  API_FANOUT_LIST_CAP,
  API_FANOUT_LIST_KEY,
  API_FANOUT_LIST_TTL_SECONDS,
  API_FANOUT_TEE_SCRIPT,
  occurrenceEventIdFor,
} = require('./lib/occurrence-events.cjs');

const {
  buildDedupMaterial,
  classifySetNxResult,
  recordDedupOutcome,
} = require('./shared/notification-dedup.cjs');

const {
  AVIATION_MIN_SERVED_COVERAGE,
  RSS_MIN_SERVED_COVERAGE,
  classifyUpstreamOutcome,
  nextBackoffMs,
  summarizeServedCoverage,
} = require('./_ingestion-coverage.cjs');

const { classifyVesselType } = require('../shared/ais-vessel-type.js');

const { readTransitWindow } = require('../shared/chokepoint-transit-window.js');

const { createDurableTransitTracker } = require('../shared/chokepoint-transit-store.js');

const { CHOKEPOINT_TRANSIT_GATES } = require('../shared/chokepoint-transit-gates.js');

// AIS upstream reconnect policy: failure classification (transport | auth |
// rate-limit), the throttle ceiling escalation, and the silence verdict. Pure and
// environment-free so tests/ais-watchdog.test.mjs exercises the whole policy
// offline (see that module's header for why this lives outside the relay).
const {
  aisSilenceVerdict,
  classifyAisFailure,
  createAisReconnectPolicy,
} = require('../shared/ais-watchdog.js');

const parseProxyUrl = parseProxyConfig;

const httpsKeepAliveAgent = new https.Agent({ keepAlive: true, maxSockets: 6, timeout: 60_000 });

function requireShared(name) {
  const candidates = [path.join(__dirname, '..', 'shared', name), path.join(__dirname, 'shared', name)];
  for (const p of candidates) { try { return require(p); } catch {} }
  throw new Error(`Cannot find shared/${name}`);
}

const RSS_ALLOWED_DOMAINS = new Set(requireShared('rss-allowed-domains.cjs'));

// /rss is public and the allowlisted hosts' DNS belongs to 428 third parties.
// Vet every answer and connect only to a vetted address, so a dangling or
// rebound feed hostname cannot read Railway-internal endpoints through us.
const rssGuardedLookup = createGuardedLookup();

const RSS_ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

const RSS_MAX_BODY_BYTES = 5 * 1024 * 1024;

const RELAY_TEST_MODE = process.env.RELAY_TEST_MODE === 'true';

const AISSTREAM_URL = RELAY_TEST_MODE && process.env.AISSTREAM_URL
  ? process.env.AISSTREAM_URL
  : 'wss://stream.aisstream.io/v0/stream';

const API_KEY = process.env.AISSTREAM_API_KEY || process.env.VITE_AISSTREAM_API_KEY;

const PORT = 80;

 // Cap WS clients — app uses HTTP snapshots, not WS
const UPSTREAM_QUEUE_HIGH_WATER = Math.max(500, Number(process.env.AIS_UPSTREAM_QUEUE_HIGH_WATER || 4000));

const UPSTREAM_QUEUE_LOW_WATER = Math.max(
  100,
  Math.min(UPSTREAM_QUEUE_HIGH_WATER - 1, Number(process.env.AIS_UPSTREAM_QUEUE_LOW_WATER || 1000))
);

const UPSTREAM_QUEUE_HARD_CAP = Math.max(
  UPSTREAM_QUEUE_HIGH_WATER + 1,
  Number(process.env.AIS_UPSTREAM_QUEUE_HARD_CAP || 8000)
);

const UPSTREAM_DRAIN_BATCH = Math.max(1, Number(process.env.AIS_UPSTREAM_DRAIN_BATCH || 250));

const UPSTREAM_DRAIN_BUDGET_MS = Math.max(2, Number(process.env.AIS_UPSTREAM_DRAIN_BUDGET_MS || 20));

function safeInt(envVal, fallback, min) {
  if (envVal == null || envVal === '') return fallback;
  const n = Number(envVal);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

// Durations are compared on a MONOTONIC clock. A wall-clock step (NTP correction,
// suspend/resume) can move Date.now() backwards, which makes a
// `Date.now() - lastPositionAt` delta negative and suppresses staleness detection
// for an unbounded time — the one failure that hides itself. Wall time is still
// recorded, but only ever to show an operator an age or a timestamp.
const monoNow = () => performance.now();

// Retry-After is either delta-seconds or an HTTP-date. Only those two documented
// forms are accepted and the result is capped at a day: a malformed or hostile
// header must not be able to park the feed for an arbitrary time, so anything
// unparseable returns null and the ladder decides instead.
function parseRetryAfterHeaderMs(raw) {
  if (raw == null) return null;
  const text = String(raw).trim();
  const DAY_MS = 24 * 60 * 60 * 1000;
  if (/^\d+$/.test(text)) {
    const seconds = Number(text);
    return seconds > 0 ? Math.min(seconds * 1000, DAY_MS) : null;
  }
  const at = Date.parse(text);
  if (!Number.isFinite(at)) return null;
  const deltaMs = at - Date.now();
  return deltaMs > 0 ? Math.min(deltaMs, DAY_MS) : null;
}

const MAX_VESSELS = safeInt(process.env.AIS_MAX_VESSELS, 20000, 1000);

const MAX_VESSEL_HISTORY = safeInt(process.env.AIS_MAX_VESSEL_HISTORY, 20000, 1000);

const MAX_DENSITY_CELLS = 5000;

const RELAY_RATE_LIMIT_WINDOW_MS = Math.max(1000, Number(process.env.RELAY_RATE_LIMIT_WINDOW_MS || 60000));

const RELAY_LOG_THROTTLE_MS = Math.max(1000, Number(process.env.RELAY_LOG_THROTTLE_MS || 10000));

// OpenSky route selection — ONE selected route, never a cascade.
//
// OpenSky's rate limit is per ACCOUNT (4,000 credits/day, keyed on OPENSKY_CLIENT_ID —
// see scripts/_opensky-account-cooldown.cjs and
// docs/solutions/integration-issues/opensky-bbox-area-billing-flat-top-tier.md), NOT per
// exit IP. A residential exit therefore buys no extra quota, and an automatic
// proxy-on-failure fallback would spend a SECOND account credit retrying the one error
// class a different IP cannot fix (429). That is strictly worse on both axes: more paid
// proxy bytes AND faster quota exhaustion. So the route is selected once, the way
// _gdelt-fetch.mjs selects its own.
//
// `direct` is the default because it is free — OpenSky was 82.5% of the residential
// proxy bill (24.86 GB / $136.75 of a ~$165 quarter) for no quota benefit. `proxy` is
// the operator escape hatch for a genuine IP-level rejection, which is counted
// separately as openskyRouteRejection (403/451) so the health surface can tell
// "flip the route" apart from "wait for credits".
const OPENSKY_ROUTE_DEFAULT = 'direct';

const OPENSKY_ROUTES = Object.freeze(['direct', 'proxy']);

function resolveOpenSkyRoute(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return OPENSKY_ROUTE_DEFAULT;
  if (OPENSKY_ROUTES.includes(value)) return value;
  console.warn(
    `[Relay] Ignoring unknown OPENSKY_ROUTE="${raw}" — expected ${OPENSKY_ROUTES.join(' or ')}; `
    + `using "${OPENSKY_ROUTE_DEFAULT}"`,
  );
  return OPENSKY_ROUTE_DEFAULT;
}

const OPENSKY_ROUTE_REQUESTED = resolveOpenSkyRoute(process.env.OPENSKY_ROUTE);

const OPENSKY_PROXY_AUTH = process.env.OPENSKY_PROXY_AUTH || process.env.PROXY_URL || '';

const OPENSKY_PROXY_ENABLED = OPENSKY_ROUTE_REQUESTED === 'proxy' && !!OPENSKY_PROXY_AUTH;

// The EFFECTIVE route — what requests actually do, which is the only thing an operator
// can act on. Derived from OPENSKY_PROXY_ENABLED rather than tracked separately so the
// two can never disagree: `OPENSKY_ROUTE=proxy` with no credential silently falls back
// to direct, and reporting the REQUESTED value there would send an operator hunting a
// proxy that was never in the request path — in exactly the misconfiguration this
// telemetry exists to diagnose. The requested value stays available for the mismatch.
const OPENSKY_ROUTE = OPENSKY_PROXY_ENABLED ? 'proxy' : 'direct';

const PROXY_URL = process.env.PROXY_URL || '';

 // generic residential proxy (US exit) — http://user:pass@host:port or host:port:user:pass (Decodo)

// Tzeva Adom (primary) + OREF (fallback) siren alerts
const TZEVA_ADOM_URL = 'https://api.tzevaadom.co.il/notifications';

const OREF_PROXY_AUTH = process.env.OREF_PROXY_AUTH || '';

 // format: user:pass@host:port
const OREF_ALERTS_URL = 'https://www.oref.org.il/WarningMessages/alert/alerts.json';

const OREF_HISTORY_URL = 'https://www.oref.org.il/WarningMessages/alert/History/AlertsHistory.json';

const OREF_POLL_INTERVAL_MS = Math.max(30_000, Number(process.env.OREF_POLL_INTERVAL_MS || 300_000));

const OREF_PROXY_AVAILABLE = !!OREF_PROXY_AUTH;

const SIREN_ALERTS_ENABLED = true;

 // Tzeva Adom is free, no proxy needed

// Hebrew→English translation dictionaries for siren alerts
const OREF_THREAT_TRANSLATIONS = (() => {
  try { return JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'data', 'oref-threat-translations-he-en.json'), 'utf8')); }
  catch { return {}; }
})();

const OREF_CITY_TRANSLATIONS = (() => {
  try { return JSON.parse(require('fs').readFileSync(path.join(__dirname, '..', 'data', 'israeli-localities-he-en.json'), 'utf8')); }
  catch { return {}; }
})();

function translateHebrew(text) {
  if (!text) return text;
  if (OREF_THREAT_TRANSLATIONS[text]) return OREF_THREAT_TRANSLATIONS[text];
  if (OREF_CITY_TRANSLATIONS[text]) return OREF_CITY_TRANSLATIONS[text];
  let result = text;
  for (const [heb, eng] of Object.entries(OREF_THREAT_TRANSLATIONS)) {
    if (result.includes(heb)) result = result.replace(heb, eng);
  }
  return result;
}

function translateCity(city) {
  if (!city) return city;
  return OREF_CITY_TRANSLATIONS[city] || city;
}

const OREF_DATA_DIR = process.env.OREF_DATA_DIR || '';

const OREF_LOCAL_FILE = (() => {
  if (!OREF_DATA_DIR) return '';
  try {
    const stat = require('fs').statSync(OREF_DATA_DIR);
    if (!stat.isDirectory()) { console.warn(`[Relay] OREF_DATA_DIR is not a directory: ${OREF_DATA_DIR}`); return ''; }
  } catch { console.warn(`[Relay] OREF_DATA_DIR does not exist: ${OREF_DATA_DIR}`); return ''; }
  console.log(`[Relay] OREF local persistence: ${OREF_DATA_DIR}`);
  return path.join(OREF_DATA_DIR, 'oref-history.json');
})();

// ─────────────────────────────────────────────────────────────
// Upstash Redis REST helpers — persist OREF history across restarts
// ─────────────────────────────────────────────────────────────
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';

const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

const UPSTASH_ENABLED = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

// Node's https module can't speak to a plain-http endpoint — resolve the
// matching client once at startup instead of hardcoding https.request at
// each upstash* call site below.
const UPSTASH_HTTP_MODULE = UPSTASH_REDIS_REST_URL.startsWith('http://') ? http : https;

const RELAY_ENV_PREFIX = '';

const OREF_REDIS_KEY = `${RELAY_ENV_PREFIX}relay:oref:history:v1`;

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

function upstashGet(key, onFailure, timeoutMs = 5000) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(null);
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (reason) => {
      if (settled) return;
      settled = true;
      if (onFailure) onFailure(reason);
      resolve(null);
    };
    const requestTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 5000;
    const url = new URL(`/get/${encodeURIComponent(key)}`, UPSTASH_REDIS_REST_URL);
    const req = UPSTASH_HTTP_MODULE.request(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}` },
      timeout: requestTimeoutMs,
    }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) {
        resp.resume();
        return fail(`HTTP ${resp.statusCode}`);
      }
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed?.result) {
            try {
              return finish(JSON.parse(parsed.result));
            } catch (e) {
              return fail(`JSON result parse failed: ${(e && e.message) || e}`);
            }
          }
          finish(null);
        } catch (e) {
          fail(`JSON response parse failed: ${(e && e.message) || e}`);
        }
      });
    });
    req.on('error', (e) => fail((e && e.message) || e));
    req.on('timeout', () => { req.destroy(); fail('timeout'); });
    req.end();
  });
}

function upstashSet(key, value, ttlSeconds) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(false);
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)]);
    const req = UPSTASH_HTTP_MODULE.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(parsed?.result === 'OK');
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

// Only wm:events:queue is pushed here. Nothing consumes that queue in the
// personal build, so the LPUSH carries an LTRIM in the same pipeline that
// keeps the newest 1000 entries.
function upstashLpush(key, value) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(false);
    const url = new URL('/pipeline', UPSTASH_REDIS_REST_URL);
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const body = JSON.stringify([['LPUSH', key, serialized], ['LTRIM', key, '0', '999']]);
    const req = UPSTASH_HTTP_MODULE.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const pushed = JSON.parse(data)?.[0]?.result;
          resolve(typeof pushed === 'number' && pushed > 0);
        } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function upstashSetNx(key, value, ttlSeconds) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve('disabled');
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    const body = JSON.stringify(['SET', key, serialized, 'NX', 'EX', String(ttlSeconds)]);
    const req = UPSTASH_HTTP_MODULE.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve(classifySetNxResult(parsed?.result));
        } catch { resolve('error'); }
      });
    });
    req.on('error', () => resolve('error'));
    req.on('timeout', () => { req.destroy(); resolve('error'); });
    req.end(body);
  });
}

// ─────────────────────────────────────────────────────────────
// Boot-seed freshness guard
//
// ais-relay is a long-running HTTP service on proxy.worldmonitor.app that
// Railway recycles frequently (deploys, crashes, OOM). Every seed loop fires an
// IMMEDIATE seed on boot and then schedules a setInterval at its real cadence —
// but the process is usually recycled long before that interval elapses, so the
// boot seed, not the interval, is the de-facto scheduler. During a reboot storm
// that means every upstream gets re-fetched on every boot (~8 min apart in the
// wild, observed 2026-06-06) instead of on its interval: paid credits burned for
// ScrapeCreators, and rate-limit/ban risk for Reddit, Yahoo, CoinGecko, UCDP,
// OpenSky, CelesTrak, USNI, etc.
//
// bootSeedDelayMs gates the immediate boot seed on the existing seed-meta age:
// it runs the seed immediately only when the data is already older than its
// interval (i.e. a refresh is actually due). On a frequently-recycled relay this
// self-throttles the boot seed to the intended cadence. On a long-lived relay,
// startBootSeedLoop schedules the first skipped refresh for the remaining
// freshness window and only then starts the recurring interval, so a restart near
// the end of a long interval does not push the next fetch out by another full
// interval.
//
// It keys on `fetchedAt` ("recently attempted — don't re-attempt"), NOT
// recordCount/status, so a recent FAILED attempt also suppresses the next-boot
// retry. That is deliberate: re-attempting a failing paid upstream on every 8-min
// reboot is the exact abuse being prevented. Seeders that only write seed-meta on
// success leave `fetchedAt` stale on failure and so still retry on boot; the
// in-process retry timers cover stable relays.
//
// `metaKey` is the FULL Redis key the seeder writes (usually `seed-meta:<key>`,
// sometimes a `relay:heartbeat:<key>` for script-delegated seeders). On any
// read/parse failure the guard logs and fails OPEN (returns 0 delay, so the
// caller seeds) so a Redis blip never starves a panel.
async function bootSeedDelayMs(label, metaKey, intervalMs) {
  if (UPSTASH_ENABLED && metaKey && intervalMs > 0) {
    const meta = await upstashGet(metaKey, (reason) => {
      console.warn(`[${label}] Boot freshness check failed (${reason}); seeding`);
    });
    const fetchedAt = Number(meta && meta.fetchedAt) || 0;
    if (fetchedAt > 0) {
      const ageMs = Date.now() - fetchedAt;
      if (ageMs >= 0 && ageMs < intervalMs) {
        const delayMs = intervalMs - ageMs;
        console.log(`[${label}] Boot seed delayed — data fresh (age ${Math.round(ageMs / 60000)}min < ${Math.round(intervalMs / 60000)}min interval); next refresh in ${Math.round(delayMs / 60000)}min`);
        return delayMs;
      }
    }
  }
  return 0;
}

function startBootSeedLoop(label, metaKey, intervalMs, seedFn, onInitialError, onSeedError = onInitialError) {
  let intervalStarted = false;
  const startInterval = () => {
    if (intervalStarted) return;
    intervalStarted = true;
    setInterval(() => {
      seedFn().catch(onSeedError);
    }, intervalMs).unref?.();
  };

  bootSeedDelayMs(label, metaKey, intervalMs).then((delayMs) => {
    if (delayMs > 0) {
      const timer = setTimeout(() => {
        Promise.resolve()
          .then(seedFn)
          .catch(onInitialError)
          .finally(startInterval);
      }, delayMs);
      timer.unref?.();
      return;
    }
    seedFn().catch(onInitialError);
    startInterval();
  }).catch((e) => {
    onInitialError(e);
    seedFn().catch(onInitialError);
    startInterval();
  });
}

function upstashDel(key) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(false);
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(['DEL', key]);
    const req = UPSTASH_HTTP_MODULE.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (resp) => {
      let data = '';
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try { resolve(JSON.parse(data)?.result === 1); } catch { resolve(false); }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end(body);
  });
}

function upstashEval(script, keys, args) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(null);
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(['EVAL', script, String(keys.length), ...keys, ...args.map((arg) => String(arg))]);
    const req = UPSTASH_HTTP_MODULE.request(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${UPSTASH_REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      timeout: 5000,
    }, (resp) => {
      let data = '';
      resp.on('error', () => resolve(null));
      resp.on('aborted', () => resolve(null));
      resp.on('data', (chunk) => { data += chunk; });
      resp.on('end', () => {
        try { resolve(JSON.parse(data)?.result); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.end(body);
  });
}

// ─────────────────────────────────────────────────────────────
// Seed envelope — canonical { _seed, data } shape. Mirrored from
// scripts/_seed-envelope-source.mjs (ESM; can't be require()'d from CJS).
// Source of truth lives there + api/_seed-envelope.js + server/_shared/seed-envelope.ts.
// Parity enforced by scripts/verify-seed-envelope-parity.mjs.
// ─────────────────────────────────────────────────────────────
function buildEnvelope({ fetchedAt, recordCount, sourceVersion, schemaVersion, state, failedDatasets, errorReason, groupId, data }) {
  const _seed = { fetchedAt, recordCount, sourceVersion, schemaVersion, state };
  if (failedDatasets != null) _seed.failedDatasets = failedDatasets;
  if (errorReason != null) _seed.errorReason = errorReason;
  if (groupId != null) _seed.groupId = groupId;
  return { _seed, data };
}

// Wrap `data` in a seed envelope and write to Redis at `key` with `ttlSeconds`.
// meta: { fetchedAt?, recordCount, sourceVersion, schemaVersion?, state?, zeroOk?, groupId? }
//   - state: omit to derive ('OK_ZERO' when recordCount===0 && zeroOk, else 'OK')
//   - schemaVersion: defaults to 1
function envelopeWrite(key, data, ttlSeconds, meta) {
  const recordCount = Number(meta?.recordCount ?? 0) || 0;
  const state = meta?.state || (recordCount === 0 && meta?.zeroOk ? 'OK_ZERO' : 'OK');
  const envelope = buildEnvelope({
    fetchedAt: meta?.fetchedAt ?? Date.now(),
    recordCount,
    sourceVersion: meta?.sourceVersion || 'ais-relay',
    schemaVersion: meta?.schemaVersion ?? 1,
    state,
    groupId: meta?.groupId,
    data,
  });
  return upstashSet(key, envelope, ttlSeconds);
}

// Envelope-aware read. Mirrors server/_shared/redis.ts::getCachedJson semantics:
// returns the bare payload for contract-mode canonical keys ({_seed, data}) and
// passes legacy shapes through unchanged. MUST be used for any seeded canonical
// key — reading raw via upstashGet() on an enveloped key iterates {_seed, data}
// as payload keys and silently corrupts downstream consumers.
async function envelopeRead(key, onFailure) {
  const raw = await upstashGet(key, onFailure);
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && '_seed' in raw && 'data' in raw) {
    return raw.data;
  }
  return raw;
}

function notifySimpleHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/**
 * Second copy of a queued rss_alert / market_alert message for API-key webhook
 * subscribers. The notification relay RPOPs wm:events:queue destructively, so
 * the Shipping v2 worker drains its own list (wm:events:api:v1). One Lua round
 * trip pushes, caps and expires it; a failure here never touches the queue
 * publish that already succeeded, it only loses the event for API tenants.
 */
function teeApiFanout(eventType, msg) {
  if (!UPSTASH_ENABLED) return;
  upstashEval(API_FANOUT_TEE_SCRIPT, [API_FANOUT_LIST_KEY], [msg, API_FANOUT_LIST_CAP, API_FANOUT_LIST_TTL_SECONDS])
    .then((result) => {
      if (Number(result) !== 1) console.warn(`[Notify] API fan-out tee did not confirm (${eventType})`);
    })
    .catch((e) => console.warn(`[Notify] API fan-out tee failed (${eventType}):`, e?.message || e));
}

async function publishNotificationEvent({ eventType, payload, severity, variant, dedupTtl = 1800 }) {
  try {
    // Include variant in dedup key so each variant can independently publish the same title
    // (e.g. finance and world users both receive an alert for the same headline).
    // Slot B: when payload.coalesceKey is set (e.g. NWS VTEC family), key on it
    // instead of the title hash so adjacent-zone alerts for the same logical
    // event collapse at the publisher (queue stays clean) instead of N times
    // per recipient at the relay.
    const variantSuffix = variant ? `:${variant}` : '';
    const dedupMaterial = buildDedupMaterial(eventType, payload?.title, payload?.coalesceKey);
    const dedupKey = `wm:notif:scan-dedup:${eventType}${variantSuffix}:${notifySimpleHash(dedupMaterial)}`;
    const dedupResult = await upstashSetNx(dedupKey, '1', dedupTtl);
    const dedupDecision = recordDedupOutcome(dedupResult, {
      surface: 'ais-relay',
      eventType,
      severity,
      fallbackKey: dedupKey,
      fallbackTtlSeconds: dedupTtl,
      emitTelemetry: recordNotificationDedupSetNxError,
    });
    // Returns true once the event is queued or was already queued; callers
    // that keep their own edge state retry on false.
    if (!dedupDecision.shouldPublish) {
      if (!dedupDecision.isDuplicate) return false;
      console.log(`[Notify] Dedup hit — ${eventType}: ${String(payload.title ?? '').slice(0, 60)}`);
      return true;
    }
    const publishedAt = Date.now();
    const fanout = API_FANOUT_EVENT_TYPES.has(eventType);
    // Stable per-story / per-move id for API subscribers (occurrence-events.cjs).
    // The relay ignores it; it rides along in the queue message unchanged.
    if (fanout && payload && typeof payload === 'object' && !payload.eventId) {
      const eventId = occurrenceEventIdFor(eventType, payload, publishedAt);
      if (eventId) payload = { ...payload, eventId };
    }
    const msg = JSON.stringify({ eventType, payload, severity: dedupDecision.severity, ...(variant ? { variant } : {}), publishedAt });
    const ok = await upstashLpush('wm:events:queue', msg);
    if (ok) {
      if (fanout) teeApiFanout(eventType, msg);
      console.log(`[Notify] Queued ${dedupDecision.severity} event: ${eventType} — ${String(payload.title ?? '').slice(0, 60)}`);
      return true;
    } else {
      // Rollback the dedup key so the next poll cycle can retry — avoids silent
      // suppression for the full dedupTtl when a transient LPUSH fails.
      console.warn(`[Notify] LPUSH failed for ${eventType} — rolling back dedup key`);
      upstashDel(dedupKey).catch(() => {});
      return false;
    }
  } catch (e) {
    console.warn(`[Notify] publishNotificationEvent error (${eventType}):`, e?.message || e);
    return false;
  }
}

let upstreamSocket = null;

let upstreamReconnectTimer = null;

let upstreamReconnectAt = 0;

let upstreamLastPositionAt = 0;

// Monotonic mirrors. Every freshness DECISION reads these; the wall values above
// exist only so an operator can be told an age or a timestamp.
let upstreamLastPositionMono = 0;

let upstreamSocketOpenedMono = 0;

// The delay the reconnect policy computed for the failure that just occurred.
// `scheduleUpstreamReconnect` consumes it, so the ladder ceiling and the throttle
// escalation are decided once inside shared/ais-watchdog.js rather than re-derived
// from counters here (the two drifting apart is how a stalled feed goes unnoticed).
let upstreamPendingReconnectDelayMs = null;

let relayShuttingDown = false;

// Floors are deliberate: this change exists to stop the relay hammering a
// provider that is rejecting it, so the tunables must not open a config path to
// hammer harder. 50ms/100ms stay well below any production value while leaving
// the ladder compressible under test.
const AIS_RECONNECT_BASE_MS = safeInt(process.env.AIS_RECONNECT_BASE_MS, 5_000, 50);

const AIS_RECONNECT_MAX_MS = safeInt(process.env.AIS_RECONNECT_MAX_MS, 5 * 60 * 1000, 100);

// A 429 on the WebSocket upgrade means the provider is rate-limiting this egress
// IP, not that the stream failed transiently: the rejection lands before the API
// key is ever sent. Knocking every AIS_RECONNECT_MAX_MS keeps ~288 refused
// requests/day inside the provider's sliding window, which can sustain the block
// we are waiting out. Sustained throttling therefore escalates to a much longer
// ceiling; any non-throttle outcome clears it so ordinary disconnects keep the
// responsive schedule.
//
// Clamped at or above the ordinary ceiling: a smaller value would make
// escalation *shorten* the wait and reconnect more aggressively while throttled,
// which is the exact inverse of the intent.
const AIS_THROTTLE_RECONNECT_MAX_MS = Math.max(
  AIS_RECONNECT_MAX_MS,
  safeInt(process.env.AIS_THROTTLE_RECONNECT_MAX_MS, 30 * 60 * 1000, 100),
);

const AIS_THROTTLE_ESCALATE_AFTER = safeInt(
  process.env.AIS_THROTTLE_ESCALATE_AFTER,
  5,
  1,
);

const AIS_HANDSHAKE_TIMEOUT_MS = safeInt(
  process.env.AIS_HANDSHAKE_TIMEOUT_MS,
  30_000,
  1_000,
);

const AIS_POSITION_FRESHNESS_MS = safeInt(
  process.env.AIS_POSITION_FRESHNESS_MS,
  5 * 60 * 1000,
  1_000,
);

// Silence is REPORTED well before the connection is recycled. The provider allows
// one stream per key, so aborting on the first whiff of staleness would churn the
// only connection we are permitted to hold; telling the operator early costs
// nothing. Stale-but-not-recycled is the `positionStale` health field.
const AIS_POSITION_STALE_MS = safeInt(
  process.env.AIS_POSITION_STALE_MS,
  Math.floor(AIS_POSITION_FRESHNESS_MS * 0.6),
  100,
);

// A refused credential is not a transient failure. Ordinary retrying cannot fix a
// revoked key, and the ladder would otherwise knock hundreds of times a day on a
// provider that has already said no. The slow probe exists only to notice an
// upstream-side mistake; valid data or a credential change clears the state.
const AIS_AUTH_PROBE_MS = safeInt(
  process.env.AIS_AUTH_PROBE_MS,
  60 * 60 * 1000,
  60_000,
);

// The reconnect policy owns: what a failure MEANS, how many consecutive throttles
// have happened, whether the ceiling is escalated, and the auth terminal state.
// The relay keeps owning the transport and the single retry timer.
const aisReconnectPolicy = createAisReconnectPolicy({
  // nextBackoffMs is 0-indexed (failures already elapsed); the policy is
  // 1-indexed (failures INCLUDING this one), hence the -1. Jitter and the cap stay
  // in nextBackoffMs so there is one ladder implementation, not two.
  ladder: (attempts, ceilingMs) => nextBackoffMs(attempts - 1, AIS_RECONNECT_BASE_MS, ceilingMs),
  maxMs: AIS_RECONNECT_MAX_MS,
  throttleCeilingMs: AIS_THROTTLE_RECONNECT_MAX_MS,
  escalateAfter: AIS_THROTTLE_ESCALATE_AFTER,
  authProbeMs: AIS_AUTH_PROBE_MS,
});

const aisUpstreamMetrics = {
  connectionAttempts: 0,
  success: 0,
  throttle: 0,
  terminalFailure: 0,
  lastSuccessAt: 0,
  lastFailureAt: 0,
  lastFailure: null,
};

let upstreamPaused = false;

let upstreamQueue = [];

let upstreamQueueReadIndex = 0;

let upstreamDrainScheduled = false;

let messageCount = 0;

let droppedMessages = 0;

const requestRateBuckets = new Map();

 // key: route:ip -> { count, resetAt }
const logThrottleState = new Map();

 // key: event key -> timestamp

function isAisThrottleEscalated() {
  return aisReconnectPolicy.snapshot().escalated;
}

// Liveness is proven by DATA, never by the socket. `readyState === OPEN` only
// means a handshake succeeded once; AISstream can complete the upgrade and then
// send nothing at all — no frame, no error, no close — which is the stall this
// whole watchdog exists to catch. So readiness is recomputed from the age of the
// last ACCEPTED position, on a monotonic clock, and silence gets its own verdict
// (report at `AIS_POSITION_STALE_MS`, recycle at `AIS_POSITION_FRESHNESS_MS`).
function getAisPositionFreshness(nowMs = Date.now()) {
  const positionAgeMonoMs = upstreamLastPositionMono
    ? Math.max(0, monoNow() - upstreamLastPositionMono)
    : null;
  return {
    currentPositionReady: upstreamSocket?.readyState === WebSocket.OPEN
      && positionAgeMonoMs !== null
      && positionAgeMonoMs <= AIS_POSITION_FRESHNESS_MS,
    // Wall age, for operators. The verdict below never uses it.
    positionAgeMs: upstreamLastPositionAt
      ? Math.max(0, nowMs - upstreamLastPositionAt)
      : null,
    positionStale: positionAgeMonoMs !== null && aisSilenceVerdict({
      silentForMs: positionAgeMonoMs,
      staleMs: AIS_POSITION_STALE_MS,
      recycleAfterMs: AIS_POSITION_FRESHNESS_MS,
    }) === 'stale',
  };
}

// Safe response: guard against "headers already sent" crashes
function safeEnd(res, statusCode, headers, body) {
  if (res.headersSent || res.writableEnded) return false;
  try {
    res.writeHead(statusCode, headers);
    res.end(body);
    return true;
  } catch {
    return;
  }
}

const WORLD_BANK_COUNTRY_ALLOWLIST = new Set([
  'USA','CHN','JPN','DEU','KOR','GBR','IND','ISR','SGP','TWN',
  'FRA','CAN','SWE','NLD','CHE','FIN','IRL','AUS','BRA','IDN',
  'ARE','SAU','QAT','BHR','EGY','TUR','MYS','THA','VNM','PHL',
  'ESP','ITA','POL','CZE','DNK','NOR','AUT','BEL','PRT','EST',
  'MEX','ARG','CHL','COL','ZAF','NGA','KEN',
]);

function normalizeWorldBankCountryCodes(rawValue) {
  const parts = String(rawValue || '')
    .split(/[;,]/g)
    .map((part) => part.trim().toUpperCase())
    .filter((part) => /^[A-Z]{3}$/.test(part) && WORLD_BANK_COUNTRY_ALLOWLIST.has(part));
  return parts.length > 0 ? parts.join(';') : null;
}

function _acceptsEncoding(header, encoding) {
  if (!header) return false;
  const tokens = header.split(',');
  for (const token of tokens) {
    const parts = token.trim().split(';');
    if (parts[0].trim().toLowerCase() !== encoding) continue;
    const qPart = parts.find(p => p.trim().startsWith('q='));
    if (qPart && parseFloat(qPart.trim().substring(2)) === 0) return false;
    return true;
  }
  return false;
}

function _varyHeader(res) {
  const existing = String(res.getHeader('vary') || '');
  return existing.toLowerCase().includes('accept-encoding')
    ? existing
    : (existing ? `${existing}, Accept-Encoding` : 'Accept-Encoding');
}

// Compress & send a response (Brotli preferred ~15-20% smaller than gzip on JSON)
function sendCompressed(req, res, statusCode, headers, body) {
  if (res.headersSent || res.writableEnded) return;
  const ae = req.headers['accept-encoding'] || '';
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  if (_acceptsEncoding(ae, 'br')) {
    zlib.brotliCompress(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, (err, compressed) => {
      if (err || res.headersSent || res.writableEnded) {
        safeEnd(res, statusCode, headers, body);
        return;
      }
      safeEnd(res, statusCode, { ...headers, 'Content-Encoding': 'br', 'Vary': _varyHeader(res) }, compressed);
    });
  } else if (_acceptsEncoding(ae, 'gzip')) {
    zlib.gzip(buf, (err, compressed) => {
      if (err || res.headersSent || res.writableEnded) {
        safeEnd(res, statusCode, headers, body);
        return;
      }
      safeEnd(res, statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': _varyHeader(res) }, compressed);
    });
  } else {
    safeEnd(res, statusCode, headers, body);
  }
}

// Pre-compressed response: serve cached gzip/brotli buffer directly (zero CPU per request)
function sendPreGzipped(req, res, statusCode, headers, rawBody, gzippedBody, brotliBody) {
  if (res.headersSent || res.writableEnded) return;
  const ae = req.headers['accept-encoding'] || '';
  if (_acceptsEncoding(ae, 'br') && brotliBody) {
    safeEnd(res, statusCode, { ...headers, 'Content-Encoding': 'br', 'Vary': _varyHeader(res) }, brotliBody);
  } else if (_acceptsEncoding(ae, 'gzip') && gzippedBody) {
    safeEnd(res, statusCode, { ...headers, 'Content-Encoding': 'gzip', 'Vary': _varyHeader(res) }, gzippedBody);
  } else {
    safeEnd(res, statusCode, headers, rawBody);
  }
}

// ─────────────────────────────────────────────────────────────
// OREF Siren Alerts (Israel Home Front Command)
// Polls oref.org.il via HTTP CONNECT tunnel through residential proxy (Israel exit)
// ─────────────────────────────────────────────────────────────

function stripBom(text) {
  return text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
}

// The configured `user:pass` of the OREF proxy, so log lines can drop the
// exact secret rather than guess its shape with a pattern.
const OREF_PROXY_CREDENTIAL = (() => {
  const raw = OREF_PROXY_AUTH.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const at = raw.lastIndexOf('@');
  return at > 0 ? raw.slice(0, at) : '';
})();

// Strip proxy credentials from an error message. The literal credential goes
// first (it may contain `/`, `@` or whitespace, which no URL pattern can
// anticipate); the `//user:pass@` pattern then covers any credential that
// did not come from our own config.
function redactOrefError(msg, credential) {
  let text = String(msg || '');
  if (credential) text = text.split(credential).join('<redacted>');
  return text.replace(/\/\/[^\s/]*@/g, '//<redacted>@');
}

// What `/oref/alerts` may say about a failed poll. The curl failure text is
// the whole command line, which embeds the proxy URL; no amount of regex
// redaction should be the only thing between that and an unauthenticated
// public route. The redacted detail goes to the server log, the public state
// gets a fixed summary.
const OREF_PUBLIC_POLL_ERROR = 'OREF upstream fetch failed';

function orefPollFailure(context, err, credential) {
  const stderr = err?.stderr ? err.stderr.toString().trim() : '';
  console.warn(`[Relay] ${context}:`, redactOrefError(stderr || err?.message || String(err), credential));
  return OREF_PUBLIC_POLL_ERROR;
}

function orefDateToUTC(dateStr) {
  if (!dateStr || !dateStr.includes(' ')) return new Date().toISOString();
  const [datePart, timePart] = dateStr.split(' ');
  const [y, m, d] = datePart.split('-').map(Number);
  const [hh, mm, ss] = timePart.split(':').map(Number);
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  });
  function partsAt(ms) {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
  }
  const base2 = Date.UTC(y, m - 1, d, hh - 2, mm, ss);
  const base3 = Date.UTC(y, m - 1, d, hh - 3, mm, ss);
  const candidates = [];
  if (partsAt(base2) === dateStr) candidates.push(base2);
  if (partsAt(base3) === dateStr) candidates.push(base3);
  const ms = candidates.length ? Math.min(...candidates) : base2;
  return new Date(ms).toISOString();
}

async function orefCurlFetch(proxyAuth, url, { toFile } = {}) {
  // Use curl via child_process — Node.js TLS fingerprint (JA3) gets blocked by Akamai,
  // but curl's fingerprint passes. curl is available on Railway (Linux) and macOS.
  // execFileSync avoids shell interpolation — safe with special chars in proxy credentials.
  const exec = require('node:util').promisify(require('node:child_process').execFile);
  // Build an optional proxy args block. When no proxy is configured
  // (proxyAuth empty), OMIT the -x flag entirely — passing `-x http://`
  // (empty host) makes curl fail with "Unsupported proxy syntax".
  let proxyArgs = [];
  if (proxyAuth && proxyAuth.trim()) {
    const proxyUrl = proxyAuth.includes('://') ? proxyAuth : `http://${proxyAuth}`;
    proxyArgs = ['-x', proxyUrl];
  }
  const args = [
    '-sS', '--compressed', ...proxyArgs, '--max-time', '15',
    '-H', 'Accept: application/json',
    '-H', 'Referer: https://www.oref.org.il/',
    '-H', 'X-Requested-With: XMLHttpRequest',
  ];
  if (toFile) {
    // Write directly to disk — avoids stdout buffer overflow (ENOBUFS) for large responses
    args.push('-o', toFile);
    args.push(url);
    await exec('curl', args, { timeout: 20000, windowsHide: true, signal: shutdown.signal });
    return require('fs').readFileSync(toFile, 'utf8');
  }
  args.push(url);
  const { stdout: result } = await exec('curl', args, { encoding: 'utf8', timeout: 20000, windowsHide: true, signal: shutdown.signal });
  return result;
}

function categorizeOrefThreat(threat) {
  const t = (threat || '').toLowerCase();
  if (t.includes('missile') || t.includes('טיל') || t.includes('ballistic')) return 'MISSILE';
  if (t.includes('rocket') || t.includes('רקט')) return 'ROCKET';
  if (t.includes('drone') || t.includes('uav') || t.includes('כטב') || t.includes('hostile aircraft') || t.includes('כלי טיס')) return 'DRONE';
  if (t.includes('mortar')) return 'MORTAR';
  if (t.includes('infiltration') || t.includes('חדיר') || t.includes('מחבל')) return 'INFILTRATION';
  if (t.includes('earthquake') || t.includes('רעידת')) return 'EARTHQUAKE';
  if (t.includes('tsunami') || t.includes('צונמי')) return 'TSUNAMI';
  if (t.includes('chemical') || t.includes('hazmat') || t.includes('חומרים מסוכנים') || t.includes('רדיולוגי')) return 'HAZMAT';
  return 'ALERT';
}

async function tzevaAdomFetchAlerts() {
  try {
    const resp = await fetch(TZEVA_ADOM_URL, {
      headers: { 'User-Agent': 'WorldMonitor/1.0', Accept: 'application/json' },
      signal: AbortSignal.timeout(12_000),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!Array.isArray(data)) throw new Error('Invalid siren response');
    if (data.length === 0) return [];
    return data.map((alert) => {
      const rawThreat = alert.threat || alert.title || '';
      const rawCities = Array.isArray(alert.cities) ? alert.cities : (alert.data ? [alert.data] : []);
      let translatedThreat = translateHebrew(rawThreat);
      const translatedLocations = rawCities.map(translateCity);
      // API sometimes puts city name in threat field; detect and move to locations
      if (OREF_CITY_TRANSLATIONS[rawThreat]) {
        if (!rawCities.includes(rawThreat)) {
          translatedLocations.push(OREF_CITY_TRANSLATIONS[rawThreat]);
        }
        translatedThreat = 'Rocket/Missile Alert';
      }
      return {
        id: alert.notificationId || String(Date.now()),
        cat: categorizeOrefThreat(rawThreat),
        title: translatedThreat,
        titleHe: rawThreat,
        data: translatedLocations,
        dataHe: rawCities,
        desc: alert.desc || '',
        date: alert.date || new Date().toISOString(),
        source: 'tzeva-adom',
      };
    });
  } catch (err) {
    console.warn(`[TzevaAdom] Fetch failed: ${err?.message || err}`);
    return null;
  }
}

async function orefFetchAlerts() {
  let alerts = [];
  let source = 'none';

  // Primary: Tzeva Adom (free, no proxy needed)
  const tzevaAlerts = await tzevaAdomFetchAlerts();
  if (tzevaAlerts !== null) {
    alerts = tzevaAlerts;
    source = 'tzeva-adom';
  } else if (OREF_PROXY_AVAILABLE) {
    // Fallback: OREF direct (requires Israeli proxy)
    try {
      const raw = await orefCurlFetch(OREF_PROXY_AUTH, OREF_ALERTS_URL);
      const cleaned = stripBom(raw).trim();
      if (cleaned && cleaned !== '[]' && cleaned !== 'null') {
        try {
          const parsed = JSON.parse(cleaned);
          const orefArr = Array.isArray(parsed) ? parsed : [parsed];
          alerts = orefArr.map((a) => ({
            ...a,
            title: translateHebrew(a.title || ''),
            titleHe: a.title || '',
            data: Array.isArray(a.data) ? a.data.map(translateCity) : a.data ? [translateCity(a.data)] : [],
            dataHe: Array.isArray(a.data) ? a.data : a.data ? [a.data] : [],
            source: 'oref-direct',
          }));
          source = 'oref-direct';
        } catch { alerts = []; }
      }
    } catch (err) {
      orefState.lastError = orefPollFailure('OREF fallback poll error', err, OREF_PROXY_CREDENTIAL);
    }
  }
  if (source === 'none') {
    orefState.lastError = orefState.lastError || 'All siren sources unavailable';
    orefState.lastPollAt = Date.now();
    console.warn('[Relay] Siren poll: both Tzeva Adom and OREF failed');
    orefPreSerializeResponses();
    return;
  }

  try {

    const newJson = JSON.stringify(alerts);
    const changed = newJson !== orefState.lastAlertsJson;

    orefState.lastAlerts = alerts;
    orefState.lastAlertsJson = newJson;
    orefState.lastPollAt = Date.now();
    orefState.lastError = null;

    if (changed && alerts.length > 0) {
      orefState.history.push({
        alerts,
        timestamp: new Date().toISOString(),
      });
      orefState._persistVersion++;

      const orefTitle = alerts[0]?.title || 'Siren alert';
      const orefLocations = alerts.flatMap(a => Array.isArray(a.data) ? a.data : []);
      const orefShown = orefLocations.slice(0, 3);
      const orefOverflow = orefLocations.length - orefShown.length;
      const orefLocationSuffix = orefShown.length
        ? ' — ' + orefShown.join(', ') + (orefOverflow > 0 ? ` +${orefOverflow} areas` : '')
        : '';
      publishNotificationEvent({
        eventType: 'oref_siren',
        payload: { title: orefTitle + orefLocationSuffix, source: source === 'tzeva-adom' ? 'Tzeva Adom / Pikud HaOref' : 'OREF Pikud HaOref', countryCode: 'IL' },
        severity: 'critical',
        variant: undefined,
      }).catch(e => console.warn('[Notify] OREF publish error:', e?.message));
    }

    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    orefState.historyCount24h = orefState.history
      .filter(h => new Date(h.timestamp).getTime() > cutoff)
      .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
    const purgeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const beforeLen = orefState.history.length;
    orefState.history = orefState.history.filter(
      h => new Date(h.timestamp).getTime() > purgeCutoff
    );
    if (orefState.history.length !== beforeLen) orefState._persistVersion++;
    orefState.totalHistoryCount = orefState.history.reduce((sum, h) => {
      return sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0);
    }, 0);

    orefPreSerializeResponses();
    orefPersistHistory().catch(() => {});
  } catch (err) {
    orefState.lastError = orefPollFailure('OREF poll error', err, OREF_PROXY_CREDENTIAL);
    orefPreSerializeResponses();
  }
}

function orefPreSerializeResponses() {
  const ts = orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : new Date().toISOString();
  const alertsJson = JSON.stringify({
    configured: SIREN_ALERTS_ENABLED,
    alerts: orefState.lastAlerts || [],
    historyCount24h: orefState.historyCount24h,
    totalHistoryCount: orefState.totalHistoryCount,
    timestamp: ts,
    ...(orefState.lastError ? { error: orefState.lastError } : {}),
  });
  orefState._alertsCache = { json: alertsJson, gzip: gzipSyncBuffer(alertsJson), brotli: brotliSyncBuffer(alertsJson) };

  const historyJson = JSON.stringify({
    configured: SIREN_ALERTS_ENABLED,
    history: orefState.history || [],
    historyCount24h: orefState.historyCount24h,
    totalHistoryCount: orefState.totalHistoryCount,
    timestamp: ts,
  });
  orefState._historyCache = { json: historyJson, gzip: gzipSyncBuffer(historyJson), brotli: brotliSyncBuffer(historyJson) };
}

async function orefBootstrapHistoryFromUpstream() {
  const tmpFile = require('path').join(require('os').tmpdir(), `oref-history-${Date.now()}.json`);
  let raw;
  try {
    raw = await orefCurlFetch(OREF_PROXY_AUTH, OREF_HISTORY_URL, { toFile: tmpFile });
  } finally {
    try { require('fs').unlinkSync(tmpFile); } catch {}
  }
  const cleaned = stripBom(raw).trim();
  if (!cleaned || cleaned === '[]') return;

  const allRecords = JSON.parse(cleaned);
  const records = allRecords.slice(0, 500);
  const waves = new Map();
  for (const r of records) {
    const key = r.alertDate;
    if (!waves.has(key)) waves.set(key, []);
    waves.get(key).push(r);
  }
  const history = [];
  let totalAlertRecords = 0;
  for (const [dateStr, recs] of waves) {
    const iso = orefDateToUTC(dateStr);
    const byType = new Map();
    let typeIdx = 0;
    for (const r of recs) {
      const k = `${r.category}|${r.title}`;
      if (!byType.has(k)) {
        byType.set(k, {
          id: `${r.category}-${typeIdx++}-${dateStr.replace(/[^0-9]/g, '')}`,
          cat: String(r.category),
          title: r.title,
          data: [],
          desc: '',
          alertDate: dateStr,
        });
      }
      byType.get(k).data.push(r.data);
      totalAlertRecords++;
    }
    history.push({ alerts: [...byType.values()], timestamp: new Date(iso).toISOString() });
  }
  history.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  orefState.history = history;
  orefState.totalHistoryCount = totalAlertRecords;
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  orefState.historyCount24h = history
    .filter(h => new Date(h.timestamp).getTime() > cutoff24h)
    .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
  orefState.bootstrapSource = 'upstream';
  if (history.length > 0) orefState._persistVersion++;
  console.log(`[Relay] OREF history bootstrap: ${totalAlertRecords} records across ${history.length} waves`);
  orefSaveLocalHistory();
}

const OREF_PERSIST_MAX_WAVES = 200;

const OREF_PERSIST_TTL_SECONDS = 7 * 24 * 60 * 60;

async function orefPersistHistory() {
  if (!UPSTASH_ENABLED) return;
  if (orefState._persistVersion === orefState._lastPersistedVersion) return;
  if (orefState._persistInFlight) return;
  orefState._persistInFlight = true;
  const versionAtStart = orefState._persistVersion;
  try {
    let waves = orefState.history;
    if (waves.length > OREF_PERSIST_MAX_WAVES) {
      console.warn(`[Relay] OREF persist: truncating ${waves.length} waves to ${OREF_PERSIST_MAX_WAVES}`);
      waves = waves.slice(-OREF_PERSIST_MAX_WAVES);
    }
    const payload = {
      history: waves,
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      activeAlertCount: orefState.lastAlerts?.length || 0,
      persistedAt: new Date().toISOString(),
    };
    const ok = await envelopeWrite(OREF_REDIS_KEY, payload, OREF_PERSIST_TTL_SECONDS, { recordCount: waves.length, sourceVersion: 'oref', zeroOk: true });
    if (ok) {
      orefState._lastPersistedVersion = versionAtStart;
    }
    // Companion seed-meta:* write — the OREF payload only carries `persistedAt`
    // (an ISO string not in extractTimestamp's recognised set), so without this
    // key the regional-snapshot freshness classifier would flag the input as
    // STALE on every run (#3781). Tracked by api/health.js for staleness alerts.
    //
    // Gate on `ok`: if the envelope write failed (Upstash 5xx / network blip),
    // a successful meta write alone would tell the freshness classifier the
    // input is FRESH for data that does not actually exist in Redis. The 7d
    // meta TTL is deliberately wider than the 15min maxAgeMin so a brief
    // seed gap keeps the meta around for diagnostics; freshness still flips
    // STALE off the now-vs-fetchedAt delta.
    //
    // NOTE (#3781 review): the transit-summaries write at line ~7370 still
    // does its meta write unconditionally and has the same failure mode.
    // That is a pre-existing bug intentionally left out of scope here; it
    // should be fixed in a follow-up PR.
    if (ok) {
      await upstashSet('seed-meta:relay:oref:history', { fetchedAt: Date.now(), recordCount: waves.length }, 604800);
    }
    orefSaveLocalHistory();
  } finally {
    orefState._persistInFlight = false;
  }
}

function orefLoadLocalHistory() {
  if (!OREF_LOCAL_FILE) return null;
  try {
    const raw = require('fs').readFileSync(OREF_LOCAL_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.history) || data.history.length === 0) return null;
    const valid = data.history.every(
      h => Array.isArray(h.alerts) && typeof h.timestamp === 'string'
    );
    if (!valid) return null;
    const purgeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const filtered = data.history.filter(
      h => new Date(h.timestamp).getTime() > purgeCutoff
    );
    if (filtered.length === 0) {
      console.log('[Relay] OREF local file data all stale (>7d)');
      return null;
    }
    console.log(`[Relay] OREF local file: ${filtered.length} waves (saved ${data.savedAt || 'unknown'})`);
    return filtered;
  } catch (err) {
    if (err.code !== 'ENOENT') console.warn('[Relay] OREF local file read error:', err.message);
    return null;
  }
}

function orefSaveLocalHistory() {
  if (!OREF_LOCAL_FILE) return;
  try {
    const fs = require('fs');
    let waves = orefState.history;
    if (waves.length > OREF_PERSIST_MAX_WAVES) {
      waves = waves.slice(-OREF_PERSIST_MAX_WAVES);
    }
    const payload = JSON.stringify({
      history: waves,
      historyCount24h: orefState.historyCount24h,
      totalHistoryCount: orefState.totalHistoryCount,
      savedAt: new Date().toISOString(),
    });
    const tmpPath = OREF_LOCAL_FILE + '.tmp';
    fs.writeFileSync(tmpPath, payload, 'utf8');
    fs.renameSync(tmpPath, OREF_LOCAL_FILE);
  } catch (err) {
    console.warn('[Relay] OREF local file save error:', err.message);
  }
}

async function orefBootstrapHistoryWithRetry() {
  // Phase 0: local file (Railway volume — instant, no network)
  if (OREF_LOCAL_FILE) {
    const local = orefLoadLocalHistory();
    if (local && local.length > 0) {
      const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
      orefState.history = local;
      orefState.totalHistoryCount = local.reduce((sum, h) => {
        return sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0);
      }, 0);
      orefState.historyCount24h = local
        .filter(h => new Date(h.timestamp).getTime() > cutoff24h)
        .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
      const newest = local[local.length - 1];
      orefState.lastAlertsJson = JSON.stringify(newest.alerts);
      orefState.bootstrapSource = 'local-file';
      console.log(`[Relay] OREF history loaded from local file: ${orefState.totalHistoryCount} records across ${local.length} waves`);
      return;
    }
  }

  // Phase 1: try Redis first
  try {
    // envelopeRead unwraps the {_seed, data} shape written by orefPersistHistory()
    // at line 1133. Reading raw left cached.history undefined, so OREF state was
    // never restored across relay restarts (reported in PR #3139 review).
    const cached = await envelopeRead(OREF_REDIS_KEY);
    if (cached && Array.isArray(cached.history) && cached.history.length > 0) {
      const valid = cached.history.every(
        h => Array.isArray(h.alerts) && typeof h.timestamp === 'string'
      );
      if (valid) {
        const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
        const purgeCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const filtered = cached.history.filter(
          h => new Date(h.timestamp).getTime() > purgeCutoff
        );
        if (filtered.length > 0) {
          orefState.history = filtered;
          orefState.totalHistoryCount = filtered.reduce((sum, h) => {
            return sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0);
          }, 0);
          orefState.historyCount24h = filtered
            .filter(h => new Date(h.timestamp).getTime() > cutoff24h)
            .reduce((sum, h) => sum + h.alerts.reduce((s, a) => s + (Array.isArray(a.data) ? a.data.length : 1), 0), 0);
          const newest = filtered[filtered.length - 1];
          orefState.lastAlertsJson = JSON.stringify(newest.alerts);
          orefState.bootstrapSource = 'redis';
          console.log(`[Relay] OREF history loaded from Redis: ${orefState.totalHistoryCount} records across ${filtered.length} waves (persisted ${cached.persistedAt || 'unknown'})`);
          return;
        }
        console.log('[Relay] OREF Redis data all stale (>7d) — falling through to upstream');
      }
    }
  } catch (err) {
    console.warn('[Relay] OREF Redis bootstrap failed:', err?.message || err);
  }

  // Phase 2: upstream with retry + exponential backoff
  const MAX_ATTEMPTS = 3;
  const BASE_DELAY_MS = 3000;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await orefBootstrapHistoryFromUpstream();
      if (UPSTASH_ENABLED) {
        await orefPersistHistory().catch(() => {});
      }
      console.log(`[Relay] OREF upstream bootstrap succeeded on attempt ${attempt}`);
      return;
    } catch (err) {
      const msg = redactOrefError(err?.message || String(err), OREF_PROXY_CREDENTIAL);
      console.warn(`[Relay] OREF upstream bootstrap attempt ${attempt}/${MAX_ATTEMPTS} failed: ${msg}`);
      if (attempt < MAX_ATTEMPTS) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1) + Math.random() * 1000;
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  orefState.bootstrapSource = null;
  console.warn('[Relay] OREF bootstrap exhausted all attempts — starting with empty history');
}

async function startOrefPollLoop() {
  if (!SIREN_ALERTS_ENABLED) {
    console.log('[Relay] Siren alerts disabled');
    return;
  }
  console.log(`[Relay] Siren alerts: primary=Tzeva Adom, fallback=${OREF_PROXY_AVAILABLE ? 'OREF (proxy)' : 'none'}`);
  await orefBootstrapHistoryWithRetry();
  if (relayShuttingDown) return;
  console.log(`[Relay] OREF bootstrap complete (source: ${orefState.bootstrapSource || 'none'}, redis: ${UPSTASH_ENABLED})`);
  orefFetchAlerts().catch(e => console.warn('[Relay] OREF initial poll error:', e?.message || e));
  setInterval(() => {
    orefFetchAlerts().catch(e => console.warn('[Relay] OREF poll error:', e?.message || e));
  }, OREF_POLL_INTERVAL_MS).unref?.();
  console.log(`[Relay] OREF poll loop started (interval ${OREF_POLL_INTERVAL_MS}ms)`);
}

const UCDP_PAGE_SIZE = 1000;

 // Default capacity. The newest candidate release plus the annual floor take precedence.
// The trailing window both writers fetch and aggregate. The CII's UCDP term
// assumes exactly this window (CII_UCDP_WINDOW_DAYS; tests pin them together).
const UCDP_TRAILING_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;

// Crypto Quotes — CoinGecko → CoinPaprika fallback
const _cryptoCfg = requireShared('crypto.json');

const CRYPTO_PAPRIKA_MAP = _cryptoCfg.coinpaprika;

 // 2h — 1h buffer over 5min cron cadence (was 1h = 55min buffer)

// Shared CoinPaprika tickers fetcher — direct first, PROXY_URL fallback.
// Cached per ticker for 5 min so crypto, stablecoins, sectors, and token panels
// that run in the same cycle can share overlap without fetching the full catalog.
const _paprikaTickerCache = new Map();

const _PAPRIKA_CACHE_MS = 5 * 60 * 1000;

const _PAPRIKA_FETCH_CONCURRENCY = 4;

async function _fetchCoinPaprikaTickerById(id) {
  const url = `https://api.coinpaprika.com/v1/tickers/${encodeURIComponent(id)}?quotes=USD`;
  const direct = await cyberHttpGetJson(url, { Accept: 'application/json' }, 15000);
  if (direct && typeof direct === 'object' && direct.id) return direct;

  if (!PROXY_URL) throw new Error(`CoinPaprika ${id} direct failed and no PROXY_URL configured`);
  const proxy = { ...parseProxyUrl(PROXY_URL), tls: true };
  const resp = await fetchViaProxy(url, proxy);
  if (!resp?.ok) throw new Error(`CoinPaprika ${id} proxy HTTP ${resp?.status || 'unavailable'}`);
  const data = JSON.parse(resp.body);
  if (!data || typeof data !== 'object' || !data.id) throw new Error(`CoinPaprika ${id} proxy returned invalid ticker`);
  return data;
}

async function _fetchCoinPaprikaTickersById(paprikaIds) {
  const ids = [...new Set(paprikaIds.filter(Boolean))];
  if (ids.length === 0) return [];

  const now = Date.now();
  const tickers = [];
  const misses = [];
  for (const id of ids) {
    const cached = _paprikaTickerCache.get(id);
    if (cached && now - cached.cachedAt < _PAPRIKA_CACHE_MS) {
      tickers.push(cached.ticker);
    } else {
      misses.push(id);
    }
  }

  const results = await allSettledWithConcurrency(misses, _PAPRIKA_FETCH_CONCURRENCY, async (id) => {
    const ticker = await _fetchCoinPaprikaTickerById(id);
    _paprikaTickerCache.set(id, { ticker, cachedAt: Date.now() });
    return ticker;
  });

  const failures = [];
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      tickers.push(result.value);
    } else {
      failures.push(result.reason);
      console.warn(`[CoinPaprika] Skipping ${misses[i]}: ${result.reason?.message || result.reason}`);
    }
  }

  if (tickers.length === 0 && failures.length > 0) {
    throw new Error(`All ${failures.length} CoinPaprika ticker request(s) failed`);
  }

  return tickers;
}

async function allSettledWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, concurrency), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        results[index] = { status: 'fulfilled', value: await mapper(items[index], index) };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }));
  return results;
}

// CoinGecko's free Demo and paid Pro plans share the `CG-` key prefix but use
// different hosts + auth headers (a Demo key on the Pro host 400s). Resolve the
// tier explicitly by which env var is set — Pro wins, else Demo, else keyless.
// Mirrors scripts/_seed-utils.mjs `coingeckoEndpoint()`; this relay is CommonJS
// and cannot import the .mjs helper, so the logic is duplicated.
function coingeckoEndpoint() {
  const proKey = process.env.COINGECKO_API_KEY;
  const demoKey = process.env.COINGECKO_DEMO_API_KEY;
  const headers = { Accept: 'application/json' };
  if (proKey) {
    headers['x-cg-pro-api-key'] = proKey;
    return { base: 'https://pro-api.coingecko.com/api/v3', headers };
  }
  if (demoKey) headers['x-cg-demo-api-key'] = demoKey;
  return { base: 'https://api.coingecko.com/api/v3', headers };
}

function cyberHttpGetJson(url, reqHeaders, timeoutMs) {
  return new Promise((resolve) => {
    const req = https.get(url, { signal: AbortSignal.timeout(timeoutMs || 10000), headers: { 'User-Agent': CHROME_UA, ...reqHeaders }, timeout: timeoutMs || 10000 }, (resp) => {
      if (resp.statusCode < 200 || resp.statusCode >= 300) { resp.resume(); return resolve(null); }
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

const WINGBITS_MAX_BOX_NM = 2000;

const WINGBITS_VIEWPORT_TILE_DEGREES = 30;

const WINGBITS_MAX_VIEWPORT_AREAS = 36;

// In-memory index of recently-seen Wingbits positions, keyed by ICAO24.
// Populated on every successful bbox response; served for callsign-only lookups.
// Entries expire after 5 minutes (Wingbits data is live, stale beyond that is misleading).
const WINGBITS_POS_INDEX = new Map();

 // icao24 -> { position, ts }
const WINGBITS_POS_INDEX_TTL_MS = 5 * 60 * 1000;

function wingbitsIndexUpdate(positions) {
  const ts = Date.now();
  for (const p of positions) {
    if (p.icao24) WINGBITS_POS_INDEX.set(p.icao24, { position: p, ts });
  }
  // Prune stale entries to prevent unbounded growth.
  if (WINGBITS_POS_INDEX.size > 5000) {
    const cutoff = ts - WINGBITS_POS_INDEX_TTL_MS;
    for (const [k, v] of WINGBITS_POS_INDEX) {
      if (v.ts < cutoff) WINGBITS_POS_INDEX.delete(k);
    }
  }
}

function wingbitsIndexLookupCallsign(callsign) {
  const cutoff = Date.now() - WINGBITS_POS_INDEX_TTL_MS;
  const results = [];
  for (const { position, ts } of WINGBITS_POS_INDEX.values()) {
    if (ts < cutoff) continue;
    const cs = (position.callsign || '').trim().toUpperCase();
    if (cs.includes(callsign)) results.push(position);
  }
  return results;
}

function buildWingbitsViewportAreas(south, west, north, east) {
  const latTiles = Math.max(1, Math.ceil((north - south) / WINGBITS_VIEWPORT_TILE_DEGREES));
  const lonTiles = Math.max(1, Math.ceil((east - west) / WINGBITS_VIEWPORT_TILE_DEGREES));
  if (latTiles * lonTiles > WINGBITS_MAX_VIEWPORT_AREAS) return null;

  const areas = [];
  for (let latIndex = 0; latIndex < latTiles; latIndex += 1) {
    const tileSouth = south + latIndex * WINGBITS_VIEWPORT_TILE_DEGREES;
    const tileNorth = Math.min(north, tileSouth + WINGBITS_VIEWPORT_TILE_DEGREES);
    for (let lonIndex = 0; lonIndex < lonTiles; lonIndex += 1) {
      const tileWest = west + lonIndex * WINGBITS_VIEWPORT_TILE_DEGREES;
      const tileEast = Math.min(east, tileWest + WINGBITS_VIEWPORT_TILE_DEGREES);
      const centerLat = (tileSouth + tileNorth) / 2;
      const centerLon = (tileWest + tileEast) / 2;
      areas.push({
        alias: `viewport-${latIndex}-${lonIndex}`,
        by: 'box',
        la: centerLat,
        lo: centerLon,
        w: Math.max(1, Math.min((tileEast - tileWest) * 60 * Math.cos(centerLat * Math.PI / 180), WINGBITS_MAX_BOX_NM)),
        h: Math.max(1, Math.min((tileNorth - tileSouth) * 60, WINGBITS_MAX_BOX_NM)),
        unit: 'nm',
      });
    }
  }
  return areas;
}

async function handleWingbitsTrackRequest(req, res) {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) {
    return safeEnd(res, 503, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'WINGBITS_API_KEY not configured', positions: [] }));
  }

  const url = new URL(req.url, 'http://localhost');
  const params = url.searchParams;
  const callsignFilter = (params.get('callsign') || '').trim().toUpperCase();
  const laminStr = params.get('lamin');
  const lominStr = params.get('lomin');
  const lamaxStr = params.get('lamax');
  const lomaxStr = params.get('lomax');

  // For callsign-only searches (no bbox), serve from the in-memory position index populated
  // by recent bbox responses. On index miss, fall back to a global Wingbits API call.
  const isBboxMissing = !laminStr || !lominStr || !lamaxStr || !lomaxStr;
  if (callsignFilter && isBboxMissing) {
    const hits = wingbitsIndexLookupCallsign(callsignFilter);
    if (hits.length > 0) {
      return sendCompressed(req, res, 200,
        { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
        JSON.stringify({ positions: hits, source: 'wingbits' }));
    }
    // Index miss — flight not in any recent viewport. Try regional Wingbits API calls.
    // The v1 API rejects boxes larger than ~2000 nm, so we use a set of regional areas
    // that together cover high-traffic airspace without exceeding the size limit.
    try {
      const regionalAreas = [
        { alias: 'europe-mideast', by: 'box', la: 40, lo: 35, w: 2000, h: 2000, unit: 'nm' },
        { alias: 'asia-pacific',   by: 'box', la: 25, lo: 120, w: 2000, h: 2000, unit: 'nm' },
        { alias: 'americas',       by: 'box', la: 35, lo: -95, w: 2000, h: 2000, unit: 'nm' },
      ];
      const gbResp = await fetch('https://customer-api.wingbits.com/v1/flights', {
        method: 'POST',
        headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
        body: JSON.stringify(regionalAreas),
        signal: AbortSignal.timeout(15_000),
      });
      if (gbResp.ok) {
        const gbData = await gbResp.json();
        if (Array.isArray(gbData)) {
          const now = Date.now();
          const positions = [];
          const seenIds = new Set();
          for (const areaResult of gbData) {
            const flightList = Array.isArray(areaResult.data) ? areaResult.data
              : Array.isArray(areaResult.flights) ? areaResult.flights
              : Array.isArray(areaResult) ? areaResult : [];
            for (const f of flightList) {
              const icao24 = f.h || f.icao24 || f.id || '';
              if (!icao24 || seenIds.has(icao24)) continue;
              const cs = (f.f || f.callsign || f.flight || '').trim().toUpperCase();
              if (!cs.includes(callsignFilter)) continue;
              seenIds.add(icao24);
              positions.push({
                icao24,
                callsign: (f.f || f.callsign || f.flight || '').trim(),
                lat: f.la ?? f.latitude ?? f.lat ?? 0,
                lon: f.lo ?? f.longitude ?? f.lon ?? f.lng ?? 0,
                altitudeM: (f.ab ?? f.altitude ?? f.alt ?? 0) * 0.3048,
                groundSpeedKts: f.gs ?? f.groundSpeed ?? f.speed ?? 0,
                trackDeg: f.th ?? f.heading ?? f.track ?? 0,
                verticalRate: 0,
                onGround: f.og ?? f.gr ?? f.onGround ?? false,
                source: 'POSITION_SOURCE_WINGBITS',
                observedAt: f.ra ? new Date(f.ra).getTime() : now,
              });
            }
          }
          wingbitsIndexUpdate(positions);
          logThrottled('log', 'wingbits-callsign-global', `[Wingbits Track] global callsign fallback: ${positions.length} hits for "${callsignFilter}"`);
          return sendCompressed(req, res, 200,
            { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
            JSON.stringify({ positions, source: 'wingbits' }));
        }
      } else {
        const errBody = await gbResp.text().catch(() => '');
        console.warn(`[Wingbits Track] Regional callsign fallback error: ${gbResp.status} — ${errBody.slice(0, 200)}`);
      }
    } catch (err) {
      console.warn(`[Wingbits Track] Global callsign fallback failed: ${err?.message || err}`);
    }
    return sendCompressed(req, res, 200,
      { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ positions: [], source: 'wingbits' }));
  }

  if (isBboxMissing) {
    return safeEnd(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Missing bbox params: lamin, lomin, lamax, lomax', positions: [] }));
  }

  const lamin = Number(laminStr);
  const lomin = Number(lominStr);
  const lamax = Number(lamaxStr);
  const lomax = Number(lomaxStr);

  if (!Number.isFinite(lamin) || !Number.isFinite(lomin) || !Number.isFinite(lamax) || !Number.isFinite(lomax)) {
    return safeEnd(res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Invalid bbox params: must be finite numbers', positions: [] }));
  }

  // Clamp bbox to valid geographic ranges before computing center.
  // Map projections can produce slightly out-of-range values; Wingbits rejects la outside [-90,90].
  const clampedLamin = Math.max(-90, Math.min(90, lamin));
  const clampedLamax = Math.max(-90, Math.min(90, lamax));
  const clampedLomin = Math.max(-180, Math.min(180, lomin));
  const clampedLomax = Math.max(-180, Math.min(180, lomax));
  const south = Math.min(clampedLamin, clampedLamax);
  const north = Math.max(clampedLamin, clampedLamax);
  const west = Math.min(clampedLomin, clampedLomax);
  const east = Math.max(clampedLomin, clampedLomax);
  const areas = buildWingbitsViewportAreas(south, west, north, east);
  if (!areas) {
    return safeEnd(res, 422, { 'Content-Type': 'application/json' }, JSON.stringify({
      error: `Viewport requires more than ${WINGBITS_MAX_VIEWPORT_AREAS} Wingbits areas`,
      positions: [],
    }));
  }

  try {
    const resp = await fetch('https://customer-api.wingbits.com/v1/flights', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
      body: JSON.stringify(areas),
      signal: AbortSignal.timeout(15_000),
    });

    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.warn(`[Wingbits Track] API error: ${resp.status} — ${errBody.slice(0, 200)}`);
      return safeEnd(res, 502, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: `Wingbits API ${resp.status}`, positions: [] }));
    }

    const data = await resp.json();
    if (!Array.isArray(data)) {
      console.warn(`[Wingbits Track] Unexpected response shape: ${JSON.stringify(data).slice(0, 200)}`);
      return safeEnd(res, 502, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'Wingbits returned non-array response', positions: [] }));
    }
    const positions = [];
    const seenIds = new Set();
    const now = Date.now();

    for (const areaResult of data) {
      const flightList = Array.isArray(areaResult.data) ? areaResult.data
        : Array.isArray(areaResult.flights) ? areaResult.flights
        : Array.isArray(areaResult) ? areaResult : [];
      for (const f of flightList) {
        const icao24 = f.h || f.icao24 || f.id || '';
        if (!icao24 || seenIds.has(icao24)) continue;
        // For callsign searches, skip non-matching flights early to keep response small.
        if (callsignFilter) {
          const cs = (f.f || f.callsign || f.flight || '').trim().toUpperCase();
          if (!cs.includes(callsignFilter)) continue;
        }
        const lat = f.la ?? f.latitude ?? f.lat ?? 0;
        const lon = f.lo ?? f.longitude ?? f.lon ?? f.lng ?? 0;
        // Multi-area requests overlap at tile edges. Deduplicate and retain
        // only positions inside the original viewport so a successful
        // Wingbits response is complete and authoritative for that bbox.
        if (lat < south || lat > north || lon < west || lon > east) continue;
        seenIds.add(icao24);
        positions.push({
          icao24,
          callsign: (f.f || f.callsign || f.flight || '').trim(),
          lat,
          lon,
          altitudeM: (f.ab ?? f.altitude ?? f.alt ?? 0) * 0.3048,
          groundSpeedKts: f.gs ?? f.groundSpeed ?? f.speed ?? 0,
          trackDeg: f.th ?? f.heading ?? f.track ?? 0,
          verticalRate: 0,
          onGround: f.og ?? f.gr ?? f.onGround ?? false,
          source: 'POSITION_SOURCE_WINGBITS',
          observedAt: f.ra ? new Date(f.ra).getTime() : now,
        });
      }
    }

    // Populate in-memory index so callsign-only lookups can resolve without a global API call.
    wingbitsIndexUpdate(positions);
    logThrottled('log', 'wingbits-track', `[Wingbits Track] ${positions.length} flights for bbox ${lamin},${lomin},${lamax},${lomax}`);
    return sendCompressed(req, res, 200,
      { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30', 'CDN-Cache-Control': 'public, max-age=15' },
      JSON.stringify({ positions, source: 'wingbits' }));
  } catch (err) {
    console.warn(`[Wingbits Track] Error: ${err?.message || err}`);
    return safeEnd(res, 503, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: `Wingbits fetch failed: ${err?.message}`, positions: [] }));
  }
}

function gzipSyncBuffer(body) {
  try {
    return zlib.gzipSync(typeof body === 'string' ? Buffer.from(body) : body);
  } catch {
    return null;
  }
}

function brotliSyncBuffer(body) {
  try {
    return zlib.brotliCompressSync(
      typeof body === 'string' ? Buffer.from(body) : body,
      { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }
    );
  } catch {
    return null;
  }
}

function logThrottled(level, key, ...args) {
  const now = Date.now();
  const last = logThrottleState.get(key) || 0;
  if (now - last < RELAY_LOG_THROTTLE_MS) return;
  logThrottleState.set(key, now);
  console[level](...args);
}

const METRICS_WINDOW_SECONDS = Math.max(10, Number(process.env.RELAY_METRICS_WINDOW_SECONDS || 60));

const relayMetricsBuckets = new Map();

 // key: unix second -> rolling metrics bucket
const relayMetricsLifetime = {
  openskyRequests: 0,
  openskyCacheHit: 0,
  openskyNegativeHit: 0,
  openskyDedup: 0,
  openskyDedupNeg: 0,
  openskyDedupEmpty: 0,
  openskyMiss: 0,
  openskyUpstreamFetches: 0,
  openskyServed: 0,
  openskySuccess: 0,
  openskyThrottle: 0,
  openskyTimeout: 0,
  openskyAuthRejection: 0,
  openskyRouteRejection: 0,
  openskyFallback: 0,
  openskyTerminalFailure: 0,
  drops: 0,
  notificationDedupSetNxErrors: 0,
  notificationDedupSetNxFailOpen: 0,
  notificationDedupSetNxFailClosed: 0,
  googleFlightsRequests: 0,
  googleFlightsServed: 0,
  googleFlightsSuccess: 0,
  googleFlights429: 0,
  googleFlightsThrottle: 0,
  googleFlightsTimeout: 0,
  googleFlightsAuthRejection: 0,
  googleFlightsFallback: 0,
  googleFlightsTerminalFailure: 0,
  rssRequests: 0,
  rssServed: 0,
  rssSuccess: 0,
  rssThrottle: 0,
  rssTimeout: 0,
  rssAuthRejection: 0,
  rssFallback: 0,
  rssTerminalFailure: 0,
  aisSnapshotRequests: 0,
  aisSnapshotServed: 0,
  aisSnapshotSuccess: 0,
  aisSnapshotThrottle: 0,
  aisSnapshotTimeout: 0,
  aisSnapshotAuthRejection: 0,
  aisSnapshotUnauthorizedClient: 0,
  aisSnapshotFallback: 0,
  aisSnapshotTerminalFailure: 0,
};

let relayMetricsQueueMaxLifetime = 0;

let relayMetricsCurrentSec = 0;

let relayMetricsCurrentBucket = null;

let relayMetricsLastPruneSec = 0;

function createRelayMetricsBucket() {
  return {
    openskyRequests: 0,
    openskyCacheHit: 0,
    openskyNegativeHit: 0,
    openskyDedup: 0,
    openskyDedupNeg: 0,
    openskyDedupEmpty: 0,
    openskyMiss: 0,
    openskyUpstreamFetches: 0,
    openskyServed: 0,
    openskySuccess: 0,
    openskyThrottle: 0,
    openskyTimeout: 0,
    openskyAuthRejection: 0,
    openskyRouteRejection: 0,
    openskyFallback: 0,
    openskyTerminalFailure: 0,
    drops: 0,
    notificationDedupSetNxErrors: 0,
    notificationDedupSetNxFailOpen: 0,
    notificationDedupSetNxFailClosed: 0,
    queueMax: 0,
    googleFlightsRequests: 0,
    googleFlightsServed: 0,
    googleFlightsSuccess: 0,
    googleFlights429: 0,
    googleFlightsThrottle: 0,
    googleFlightsTimeout: 0,
    googleFlightsAuthRejection: 0,
    googleFlightsFallback: 0,
    googleFlightsTerminalFailure: 0,
    rssRequests: 0,
    rssServed: 0,
    rssSuccess: 0,
    rssThrottle: 0,
    rssTimeout: 0,
    rssAuthRejection: 0,
    rssFallback: 0,
    rssTerminalFailure: 0,
    aisSnapshotRequests: 0,
    aisSnapshotServed: 0,
    aisSnapshotSuccess: 0,
    aisSnapshotThrottle: 0,
    aisSnapshotTimeout: 0,
    aisSnapshotAuthRejection: 0,
    aisSnapshotUnauthorizedClient: 0,
    aisSnapshotFallback: 0,
    aisSnapshotTerminalFailure: 0,
  };
}

function getMetricsNowSec() {
  return Math.floor(Date.now() / 1000);
}

function pruneRelayMetricsBuckets(nowSec = getMetricsNowSec()) {
  const minSec = nowSec - METRICS_WINDOW_SECONDS + 1;
  for (const sec of relayMetricsBuckets.keys()) {
    if (sec < minSec) relayMetricsBuckets.delete(sec);
  }
  if (relayMetricsCurrentSec < minSec) {
    relayMetricsCurrentSec = 0;
    relayMetricsCurrentBucket = null;
  }
}

function getRelayMetricsBucket(nowSec = getMetricsNowSec()) {
  if (nowSec !== relayMetricsLastPruneSec) {
    pruneRelayMetricsBuckets(nowSec);
    relayMetricsLastPruneSec = nowSec;
  }

  if (relayMetricsCurrentBucket && relayMetricsCurrentSec === nowSec) {
    return relayMetricsCurrentBucket;
  }

  let bucket = relayMetricsBuckets.get(nowSec);
  if (!bucket) {
    bucket = createRelayMetricsBucket();
    relayMetricsBuckets.set(nowSec, bucket);
  }
  relayMetricsCurrentSec = nowSec;
  relayMetricsCurrentBucket = bucket;
  return bucket;
}

function incrementRelayMetric(field, amount = 1) {
  const bucket = getRelayMetricsBucket();
  bucket[field] = (bucket[field] || 0) + amount;
  if (Object.hasOwn(relayMetricsLifetime, field)) {
    relayMetricsLifetime[field] += amount;
  }
}

const RELAY_OUTCOME_FIELDS = Object.freeze({
  opensky: Object.freeze({
    success: 'openskySuccess',
    throttle: 'openskyThrottle',
    timeout: 'openskyTimeout',
    authRejection: 'openskyAuthRejection',
    // OpenSky-only: the exit IP was refused, not the credentials. Every other route
    // keeps folding 403 into authRejection, so this key is deliberately absent from
    // their maps — recordRelayOutcome drops an outcome a route does not declare.
    routeRejection: 'openskyRouteRejection',
    fallback: 'openskyFallback',
    terminalFailure: 'openskyTerminalFailure',
  }),
  googleFlights: Object.freeze({
    success: 'googleFlightsSuccess',
    throttle: 'googleFlightsThrottle',
    timeout: 'googleFlightsTimeout',
    authRejection: 'googleFlightsAuthRejection',
    fallback: 'googleFlightsFallback',
    terminalFailure: 'googleFlightsTerminalFailure',
  }),
  rss: Object.freeze({
    success: 'rssSuccess',
    throttle: 'rssThrottle',
    timeout: 'rssTimeout',
    authRejection: 'rssAuthRejection',
    fallback: 'rssFallback',
    terminalFailure: 'rssTerminalFailure',
  }),
  aisSnapshot: Object.freeze({
    success: 'aisSnapshotSuccess',
    throttle: 'aisSnapshotThrottle',
    timeout: 'aisSnapshotTimeout',
    authRejection: 'aisSnapshotAuthRejection',
    fallback: 'aisSnapshotFallback',
    terminalFailure: 'aisSnapshotTerminalFailure',
  }),
});

function recordRelayOutcome(route, outcome, amount = 1) {
  const metricField = RELAY_OUTCOME_FIELDS[route]?.[outcome];
  if (!metricField) return;
  incrementRelayMetric(metricField, amount);
}

// OpenSky-specific refinement of the shared classifier.
//
// classifyUpstreamOutcome collapses 401 and 403 into 'authRejection'. That is right for
// every other route, but for OpenSky the two say opposite things and imply opposite
// fixes: 401 = the CREDENTIALS were rejected (rotate OPENSKY_CLIENT_SECRET), 403/451 =
// the EXIT IP was rejected (flip OPENSKY_ROUTE). Conflating them is exactly why
// "is the direct route blocked?" could not be answered from telemetry.
//
// Deliberately NOT classified as a route rejection: socket errors (ECONNRESET, EPROTO,
// timeouts). Those are ordinary network noise on either route — EPROTO in particular was
// the #5074 double-TLS bug, not a block — and labelling them would send an operator to
// flip the route over a transient blip. Only an explicit refusal from the origin counts.
function classifyOpenSkyOutcome({ status, error } = {}) {
  if (status === 403 || status === 451) return 'routeRejection';
  return classifyUpstreamOutcome({ status, error });
}

function sampleRelayQueueSize(queueSize) {
  const bucket = getRelayMetricsBucket();
  if (queueSize > bucket.queueMax) bucket.queueMax = queueSize;
  if (queueSize > relayMetricsQueueMaxLifetime) relayMetricsQueueMaxLifetime = queueSize;
}

function recordNotificationDedupSetNxError({ line, action }) {
  incrementRelayMetric('notificationDedupSetNxErrors');
  incrementRelayMetric(action === 'fail_open' ? 'notificationDedupSetNxFailOpen' : 'notificationDedupSetNxFailClosed');
  console.warn(line);
}

// AIS aggregate state for snapshot API (server-side fanout)
const GRID_SIZE = 2;

const DENSITY_WINDOW = 30 * 60 * 1000;

 // 30 minutes
const GAP_THRESHOLD = 60 * 60 * 1000;

 // 1 hour
const SNAPSHOT_INTERVAL_MS = Math.max(2000, Number(process.env.AIS_SNAPSHOT_INTERVAL_MS || 5000));

const CANDIDATE_RETENTION_MS = 2 * 60 * 60 * 1000;

 // 2 hours
const MAX_DENSITY_ZONES = 200;

const MAX_CANDIDATE_REPORTS = 1500;

// Hard size cap for vesselMeta. Active global AIS fleet is ~50-70k unique
// MMSIs at any given time (UNCTAD/MarineTraffic estimates). 50k headroom
// covers steady state with the 24h TTL; a hostile or buggy upstream that
// floods unique MMSIs gets bounded after this cap. Pairs with the TTL
// loop in cleanupAggregates so eviction has both age-based and size-based
// gates, matching the pattern used by tankerReports / candidateReports /
// densityGrid / vesselHistory.
const MAX_VESSEL_META = 50000;

const vessels = new Map();

const vesselHistory = new Map();

// mmsi → timestamp of the vessel's most recent position fix. Retention must
// exceed GAP_THRESHOLD: the dark-ship return check compares the CURRENT fix
// against this value, and the vesselHistory equivalent loses the prior fix
// to its 30-minute DENSITY_WINDOW prune and 10-entry cap long before a >1h
// silence ends. Bounded by the same retention prune + recency eviction
// cleanupAggregates applies to vesselHistory.
const vesselLastFixSeen = new Map();

const LAST_FIX_RETENTION_MS = 6 * 60 * 60 * 1000;

 // 6h — 6× GAP_THRESHOLD
const densityGrid = new Map();

const candidateReports = new Map();

// Parallel store for tanker (AIS ship type 80-89) position reports — populated
// alongside candidateReports but with a different inclusion predicate.
// Required by the Energy Atlas live-tanker map layer (parity-push PR 3).
// Kept SEPARATE from candidateReports so the existing military-detection
// consumer's contract is unchanged.
const tankerReports = new Map();

// MMSI → { shipType, shipName, lastSeen } cache populated from
// ShipStaticData messages. AISStream's PositionReport message does NOT
// carry ShipType in MetaData (per their schema), so a relay that filters
// to PositionReport-only never gets the type signal — tanker classification
// (which needs shipType ∈ 80..89) is impossible on PositionReport alone.
// Static data arrives every ~6 minutes per MMSI so the cache hits steady
// state quickly. Without this, tankerReports stays permanently empty and
// the live-tanker layer renders zero vessels — root cause identified
// 2026-04-25 when the layer shipped (#3402) but rendered empty.
const vesselMeta = new Map();

const VESSEL_META_TTL_MS = 24 * 60 * 60 * 1000;

 // 24h — well over the 6-min broadcast cycle

let snapshotSequence = 0;

let lastSnapshot = null;

let lastSnapshotAt = 0;

// Pre-serialized cache: avoids JSON.stringify + gzip per request
let lastSnapshotJson = null;

       // cached JSON string (no candidates)
let lastSnapshotGzip = null;

       // cached gzip buffer (no candidates)
let lastSnapshotBrotli = null;

     // cached brotli buffer (no candidates)
let lastSnapshotWithCandJson = null;

let lastSnapshotWithCandGzip = null;

let lastSnapshotWithCandBrotli = null;

// Chokepoint spatial index: bucket vessels into grid cells at ingest time
// instead of O(chokepoints * vessels) on every snapshot
const chokepointBuckets = new Map();

 // key: gridKey -> Set of MMSI
const vesselChokepoints = new Map();

 // key: MMSI -> Set of chokepoint names

const CHOKEPOINTS = [
  { name: 'Strait of Hormuz', lat: 26.5, lon: 56.5, radius: 2 },
  { name: 'Suez Canal', lat: 30.0, lon: 32.5, radius: 1 },
  { name: 'Malacca Strait', lat: 2.5, lon: 101.5, radius: 2 },
  { name: 'Bab el-Mandeb Strait', lat: 12.5, lon: 43.5, radius: 1.5 },
  { name: 'Panama Canal', lat: 9.0, lon: -79.5, radius: 1 },
  { name: 'Taiwan Strait', lat: 24.5, lon: 119.5, radius: 2 },
  { name: 'South China Sea', lat: 15.0, lon: 115.0, radius: 5 },
  { name: 'Black Sea', lat: 43.5, lon: 34.0, radius: 3 },
  { name: 'Cape of Good Hope', lat: -34.36, lon: 18.49, radius: 2 },
  { name: 'Gibraltar Strait', lat: 35.96, lon: -5.35, radius: 1 },
  { name: 'Bosporus Strait', lat: 40.70, lon: 28.0, radius: 1.5 },
  { name: 'Korea Strait', lat: 34.0, lon: 129.0, radius: 1.5 },
  { name: 'Dover Strait', lat: 51.05, lon: 1.45, radius: 0.5 },
  { name: 'Kerch Strait', lat: 45.33, lon: 36.60, radius: 0.5 },
  { name: 'Lombok Strait', lat: -8.47, lon: 115.72, radius: 0.5 },
];

const chokepointCrossings = new Map();

const TRANSIT_COOLDOWN_MS = 30 * 60 * 1000;

const TRANSIT_WINDOW_MS = 24 * 60 * 60 * 1000;

// How long a gate sighting waits for the opposite gate. It covers the slowest
// gate-to-gate passage (about 180 nm at Malacca and the Cape) and must exceed
// DENSITY_WINDOW: the vessel table drops a vessel after 30 silent minutes.
const TRANSIT_MAX_GATE_GAP_MS = 18 * 60 * 60 * 1000;

const CHOKEPOINT_TRANSIT_KEY = 'supply_chain:chokepoint_transits:v1';

const CHOKEPOINT_TRANSIT_TTL = 3600;

 // 1h — 6x interval; survives ~5 consecutive missed pings
const transitTracker = createDurableTransitTracker({
  gates: CHOKEPOINT_TRANSIT_GATES,
  maxTransitMs: TRANSIT_MAX_GATE_GAP_MS,
  cooldownMs: TRANSIT_COOLDOWN_MS,
  evaluate: upstashEval,
});

setInterval(() => {
  transitTracker.flush(Date.now()).catch(error => console.warn('[Transit] Gate persistence failed:', error.message));
}, 10_000).unref?.();

// Dark-ship (AIS gap) count envelope — the trusted producer behind the
// temporal anomalies `ais_gaps` count source (#7574). Written on its own
// slow loop, not on the per-snapshot build: detectDisruptions runs every
// SNAPSHOT_INTERVAL_MS, which would be a Redis write per relay heartbeat.
const AIS_GAPS_REDIS_KEY = 'maritime:ais-gaps:v1';

// 60min — must STRICTLY exceed the 30min health maxStaleMin (api/health.js
// aisGaps entry) so a dead relay reads warn STALE_SEED before the envelope
// expires to crit EMPTY; 6x the seed interval.
const AIS_GAPS_TTL = 3600;

const AIS_GAPS_SEED_INTERVAL_MS = 10 * 60 * 1000;

const CHOKEPOINT_TRANSIT_INTERVAL_MS = 10 * 60 * 1000;

const NAVAL_PREFIX_RE = /^(USS|USNS|HMS|HMAS|HMCS|INS|JS|ROKS|TCG|FS|BNS|RFS|PLAN|PLA|CGC|PNS|KRI|ITS|SNS|MMSI)/i;

function getGridKey(lat, lon) {
  const gridLat = Math.floor(lat / GRID_SIZE) * GRID_SIZE;
  const gridLon = Math.floor(lon / GRID_SIZE) * GRID_SIZE;
  return `${gridLat},${gridLon}`;
}

function isLikelyMilitaryCandidate(meta, resolvedShipType) {
  const mmsi = String(meta?.MMSI || '');
  // Prefer caller-resolved shipType (typically from vesselMeta cache) so
  // PositionReport callers — where MetaData lacks ShipType — still hit the
  // type-based military arm (35/55/50-59) instead of relying purely on
  // NAVAL_PREFIX_RE + MMSI-suffix fallbacks.
  const shipType = Number.isFinite(Number(resolvedShipType))
    ? Number(resolvedShipType)
    : Number(meta?.ShipType);
  const name = (meta?.ShipName || '').trim().toUpperCase();

  if (Number.isFinite(shipType) && (shipType === 35 || shipType === 55 || (shipType >= 50 && shipType <= 59))) {
    return true;
  }

  if (name && NAVAL_PREFIX_RE.test(name)) return true;

  if (mmsi.length >= 9) {
    const suffix = mmsi.substring(3);
    if (suffix.startsWith('00') || suffix.startsWith('99')) return true;
  }

  return false;
}

function getUpstreamQueueSize() {
  return upstreamQueue.length - upstreamQueueReadIndex;
}

function enqueueUpstreamMessage(raw) {
  upstreamQueue.push(raw);
  sampleRelayQueueSize(getUpstreamQueueSize());
}

function dequeueUpstreamMessage() {
  if (upstreamQueueReadIndex >= upstreamQueue.length) return null;
  const raw = upstreamQueue[upstreamQueueReadIndex++];
  // Compact queue periodically to avoid unbounded sparse arrays.
  if (upstreamQueueReadIndex >= 1024 && upstreamQueueReadIndex * 2 >= upstreamQueue.length) {
    upstreamQueue = upstreamQueue.slice(upstreamQueueReadIndex);
    upstreamQueueReadIndex = 0;
  }
  return raw;
}

function clearUpstreamQueue() {
  upstreamQueue = [];
  upstreamQueueReadIndex = 0;
  upstreamDrainScheduled = false;
  sampleRelayQueueSize(0);
}

function evictMapByTimestamp(map, maxSize, getTimestamp) {
  if (map.size <= maxSize) return;
  const sorted = [...map.entries()].sort((a, b) => {
    const tsA = Number(getTimestamp(a[1])) || 0;
    const tsB = Number(getTimestamp(b[1])) || 0;
    return tsA - tsB;
  });
  const removeCount = map.size - maxSize;
  for (let i = 0; i < removeCount; i++) {
    map.delete(sorted[i][0]);
  }
}

function removeVesselFromChokepoints(mmsi) {
  const previous = vesselChokepoints.get(mmsi);
  if (!previous) return;

  for (const cpName of previous) {
    const bucket = chokepointBuckets.get(cpName);
    if (!bucket) continue;
    bucket.delete(mmsi);
    if (bucket.size === 0) chokepointBuckets.delete(cpName);
  }

  vesselChokepoints.delete(mmsi);
}

function updateVesselChokepoints(mmsi, lat, lon) {
  const next = new Set();
  for (const cp of CHOKEPOINTS) {
    const dlat = lat - cp.lat;
    const dlon = lon - cp.lon;
    if (dlat * dlat + dlon * dlon <= cp.radius * cp.radius) {
      next.add(cp.name);
    }
  }

  const previous = vesselChokepoints.get(mmsi) || new Set();

  for (const cpName of previous) {
    if (next.has(cpName)) continue;
    const bucket = chokepointBuckets.get(cpName);
    if (!bucket) continue;
    bucket.delete(mmsi);
    if (bucket.size === 0) chokepointBuckets.delete(cpName);
  }

  for (const cpName of next) {
    let bucket = chokepointBuckets.get(cpName);
    if (!bucket) {
      bucket = new Set();
      chokepointBuckets.set(cpName, bucket);
    }
    bucket.add(mmsi);
  }

  if (next.size === 0) vesselChokepoints.delete(mmsi);
  else vesselChokepoints.set(mmsi, next);
}

function processRawUpstreamMessage(raw, onSubscriptionError) {
  messageCount++;
  if (messageCount % 5000 === 0) {
    const mem = process.memoryUsage();
    console.log(`[Relay] ${messageCount} msgs, ${0} ws-clients, ${vessels.size} vessels, queue=${getUpstreamQueueSize()}, dropped=${droppedMessages}, rss=${(mem.rss / 1024 / 1024).toFixed(0)}MB heap=${(mem.heapUsed / 1024 / 1024).toFixed(0)}MB, cache: opensky=${openskyResponseCache.size} opensky_neg=${openskyNegativeCache.size} rss_feed=${rssResponseCache.size} rss_neg=${rssNegativeCache.size} rss_backoff=${rssFailureCount.size}`);
  }

  let acceptedType = null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error === 'string' && parsed.error.trim()) {
      onSubscriptionError(parsed.error);
      return null;
    }
    if (parsed?.MessageType === 'PositionReport') {
      if (processPositionReportForSnapshot(parsed)) acceptedType = 'position';
    } else if (parsed?.MessageType === 'ShipStaticData') {
      // Cache ShipType + ShipName by MMSI so subsequent PositionReports
      // can classify the vessel as a tanker. AISStream broadcasts static
      // data ~every 6 min per vessel; in steady state the cache covers
      // most active MMSIs within minutes of relay startup.
      if (processShipStaticDataForMeta(parsed)) acceptedType = 'static';
    }
  } catch {
    // Ignore malformed upstream payloads
  }

  // Heavily throttled WS fanout: every 50th message only
  // The app primarily uses HTTP snapshot polling, WS is for rare external consumers

  return acceptedType;
}

function processShipStaticDataForMeta(data) {
  // AISStream Type 5 (ShipStaticData). Carries ShipType, ShipName, IMO,
  // CallSign, dimensions. We only need ShipType + ShipName for classification.
  const meta = data?.MetaData;
  const sd = data?.Message?.ShipStaticData;
  if (!meta || !sd) return false;
  // MMSI fallback: AISStream's PositionReport wrapper puts MMSI under
  // MetaData.MMSI, but the ShipStaticData payload sample shows MMSI mirrored
  // as `UserID` on the message body itself. Read MetaData.MMSI first (the
  // documented wrapper field), then fall back to the message-body field so
  // a wrapper schema variant doesn't silently re-empty vesselMeta.
  const mmsi = String(meta.MMSI || sd.UserID || '');
  if (!mmsi) return false;
  // ShipType lives in the message body, not MetaData, on Type 5 frames.
  // Gate on `> 0` (not just `Number.isFinite`) so that Number(null) === 0
  // and AIS code 0 ("Not available" per ITU-R M.1371) don't overwrite a
  // previously-cached valid type. Otherwise a vessel that broadcasts
  // {Type: 85} then later {Type: null} would be downgraded to non-tanker
  // because the second write replaces the first with shipType=0.
  const shipType = Number(sd.Type);
  if (!Number.isFinite(shipType) || shipType <= 0) return false;
  vesselMeta.set(mmsi, {
    shipType,
    shipName: (sd.Name || meta.ShipName || '').trim(),
    lastSeen: Date.now(),
  });
  return true;
}

function processPositionReportForSnapshot(data) {
  const meta = data?.MetaData;
  const pos = data?.Message?.PositionReport;
  if (!meta || !pos) return false;

  const mmsi = String(meta.MMSI || '');
  if (!mmsi) return false;

  const lat = Number.isFinite(pos.Latitude) ? pos.Latitude : meta.latitude;
  const lon = Number.isFinite(pos.Longitude) ? pos.Longitude : meta.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return false;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return false;

  const now = Date.now();

  // Resolve ShipType ONCE per position report and feed it to every consumer
  // below (vessels record, military classifier, tanker capture). Pre-fix,
  // each consumer read meta.ShipType directly — but AISStream's PositionReport
  // MetaData does NOT carry that field; ShipType only arrives via Type 5
  // ShipStaticData frames cached in vesselMeta. The consequence wasn't just
  // an empty tanker layer (PR #3410 original scope) — `vessels[mmsi].shipType`
  // was also undefined, so classifyVesselType(vessel?.shipType) used by
  // chokepoint transit logging at line ~6555 always returned 'other'. That
  // silently broke per-type transit counts in /seedChokepointTransits and
  // every downstream consumer of transit-by-type breakdowns. PR3410 review
  // catch — same root cause, same vesselMeta cache fixes all three sites.
  const cachedMeta = vesselMeta.get(mmsi);
  const effectiveShipType = Number.isFinite(Number(meta.ShipType))
    ? Number(meta.ShipType)
    : (cachedMeta ? cachedMeta.shipType : undefined);

  vessels.set(mmsi, {
    mmsi,
    name: meta.ShipName || (cachedMeta && cachedMeta.shipName) || '',
    lat,
    lon,
    timestamp: now,
    shipType: effectiveShipType,
    heading: pos.TrueHeading,
    speed: pos.Sog,
    course: pos.Cog,
  });

  const history = vesselHistory.get(mmsi) || [];
  // Dark-ship return detection (#7574): a fix arriving more than
  // GAP_THRESHOLD after the previous one marks the vessel as returned from
  // extended AIS silence. The prior fix is read from vesselLastFixSeen, NOT
  // from vesselHistory — cleanupAggregates prunes vesselHistory to the
  // 30-min DENSITY_WINDOW and caps it at 10 entries, so by the time a >1h
  // silence ends the old fix is long gone from that structure and a
  // history-diffing form of this check can never fire.
  const lastFixAt = vesselLastFixSeen.get(mmsi);
  if (lastFixAt && now - lastFixAt > GAP_THRESHOLD) {
    darkShipReturns.set(mmsi, now);
  }
  vesselLastFixSeen.set(mmsi, now);
  history.push(now);
  if (history.length > 10) history.shift();
  vesselHistory.set(mmsi, history);

  const gridKey = getGridKey(lat, lon);
  let cell = densityGrid.get(gridKey);
  if (!cell) {
    cell = {
      lat: Math.floor(lat / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      lon: Math.floor(lon / GRID_SIZE) * GRID_SIZE + GRID_SIZE / 2,
      vessels: new Set(),
      lastUpdate: now,
      previousCount: 0,
    };
    densityGrid.set(gridKey, cell);
  }
  cell.vessels.add(mmsi);
  cell.lastUpdate = now;

  // Maintain exact chokepoint membership so moving vessels don't get "stuck" in old buckets.
  updateVesselChokepoints(mmsi, lat, lon);
  transitTracker.observe(mmsi, lat, lon, classifyVesselType(effectiveShipType), now);

  if (isLikelyMilitaryCandidate(meta, effectiveShipType)) {
    candidateReports.set(mmsi, {
      mmsi,
      name: meta.ShipName || (cachedMeta && cachedMeta.shipName) || '',
      lat,
      lon,
      shipType: effectiveShipType,
      heading: pos.TrueHeading,
      speed: pos.Sog,
      course: pos.Cog,
      timestamp: now,
    });
  }

  // Tanker capture for the Energy Atlas live-tanker layer. AIS ship type
  // 80-89 covers all tanker subtypes per ITU-R M.1371 (oil/chemical tanker,
  // hazardous cargo classes A-D, and other tanker variants). Stored in a
  // SEPARATE Map from candidateReports so the existing military-detection
  // consumer never sees tankers (their contract is unchanged).
  const shipType = Number.isFinite(Number(effectiveShipType)) ? Number(effectiveShipType) : NaN;
  if (Number.isFinite(shipType) && shipType >= 80 && shipType <= 89) {
    tankerReports.set(mmsi, {
      mmsi,
      name: (cachedMeta && cachedMeta.shipName) || meta.ShipName || '',
      lat,
      lon,
      shipType,
      heading: pos.TrueHeading,
      speed: pos.Sog,
      course: pos.Cog,
      timestamp: now,
    });
  }
  return true;
}

function cleanupAggregates() {
  const now = Date.now();
  const cutoff = now - DENSITY_WINDOW;

  for (const [mmsi, vessel] of vessels) {
    if (vessel.timestamp < cutoff) {
      vessels.delete(mmsi);
      removeVesselFromChokepoints(mmsi);
    }
  }
  // Hard cap: if still over limit, evict oldest
  if (vessels.size > MAX_VESSELS) {
    const sorted = [...vessels.entries()].sort((a, b) => a[1].timestamp - b[1].timestamp);
    const toRemove = sorted.slice(0, vessels.size - MAX_VESSELS);
    for (const [mmsi] of toRemove) {
      vessels.delete(mmsi);
      removeVesselFromChokepoints(mmsi);
    }
  }

  for (const [mmsi, history] of vesselHistory) {
    const filtered = history.filter((ts) => ts >= cutoff);
    if (filtered.length === 0) {
      vesselHistory.delete(mmsi);
    } else {
      vesselHistory.set(mmsi, filtered);
    }
  }
  // Retention prune + recency cap for the dark-ship last-fix map: entries
  // older than the retention window can never be part of a live >1h silence
  // comparison again, and the cap bounds memory against vessel churn.
  const lastFixCutoff = now - LAST_FIX_RETENTION_MS;
  for (const [mmsi, ts] of vesselLastFixSeen) {
    if (ts < lastFixCutoff) vesselLastFixSeen.delete(mmsi);
  }
  evictMapByTimestamp(vesselLastFixSeen, MAX_VESSEL_HISTORY, (ts) => ts);
  // Hard cap: keep the most recent vessel histories.
  evictMapByTimestamp(vesselHistory, MAX_VESSEL_HISTORY, (history) => history[history.length - 1] || 0);

  for (const [key, cell] of densityGrid) {
    cell.previousCount = cell.vessels.size;

    for (const mmsi of cell.vessels) {
      const vessel = vessels.get(mmsi);
      if (!vessel || vessel.timestamp < cutoff) {
        cell.vessels.delete(mmsi);
      }
    }

    if (cell.vessels.size === 0 && now - cell.lastUpdate > DENSITY_WINDOW * 2) {
      densityGrid.delete(key);
    }
  }
  // Hard cap: keep the most recently updated cells.
  evictMapByTimestamp(densityGrid, MAX_DENSITY_CELLS, (cell) => cell.lastUpdate || 0);

  for (const [mmsi, report] of candidateReports) {
    if (report.timestamp < now - CANDIDATE_RETENTION_MS) {
      candidateReports.delete(mmsi);
    }
  }
  // Hard cap: keep freshest candidate reports.
  evictMapByTimestamp(candidateReports, MAX_CANDIDATE_REPORTS, (report) => report.timestamp || 0);

  // Tanker reports: same retention window as candidate reports — a vessel
  // that hasn't broadcast a position in CANDIDATE_RETENTION_MS is no longer
  // useful for a live-tanker map layer. Cap at 2× the per-response cap so
  // we have headroom for bbox filtering to find recent fixes anywhere on
  // the globe (not just one chokepoint).
  for (const [mmsi, report] of tankerReports) {
    if (report.timestamp < now - CANDIDATE_RETENTION_MS) {
      tankerReports.delete(mmsi);
    }
  }
  evictMapByTimestamp(tankerReports, MAX_TANKER_REPORTS_PER_RESPONSE * 10, (report) => report.timestamp || 0);

  // vesselMeta TTL eviction: drop entries older than VESSEL_META_TTL_MS so
  // long-running relays don't accumulate metadata for vessels that have
  // sailed out of any tracked region. ShipStaticData is rebroadcast every
  // ~6 min, so a 24h TTL covers vessels with intermittent visibility.
  for (const [mmsi, entry] of vesselMeta) {
    if (entry.lastSeen < now - VESSEL_META_TTL_MS) {
      vesselMeta.delete(mmsi);
    }
  }
  // Hard size cap as defense-in-depth against a hostile/buggy upstream
  // flooding unique MMSIs faster than the TTL eviction can drain them.
  // Matches the pattern used by every peer Map in this function.
  evictMapByTimestamp(vesselMeta, MAX_VESSEL_META, (entry) => entry.lastSeen || 0);

  // Clean chokepoint buckets: remove stale vessels
  for (const [cpName, bucket] of chokepointBuckets) {
    for (const mmsi of bucket) {
      if (vessels.has(mmsi)) continue;
      bucket.delete(mmsi);
      const memberships = vesselChokepoints.get(mmsi);
      if (memberships) {
        memberships.delete(cpName);
        if (memberships.size === 0) vesselChokepoints.delete(mmsi);
      }
    }
    if (bucket.size === 0) chokepointBuckets.delete(cpName);
  }

  for (const [cpName, crossings] of chokepointCrossings) {
    const filtered = crossings.filter(c => now - c.ts < TRANSIT_WINDOW_MS);
    if (filtered.length === 0) chokepointCrossings.delete(cpName);
    else chokepointCrossings.set(cpName, filtered);
  }
  transitTracker.prune(now);
}

// Vessels seen again after extended AIS silence: mmsi → the return-seen
// timestamp. Entries are bounded by the 10-minute freshness window in
// countDarkShips (pruned on read) and the 10-entry vesselHistory cap, so the
// map cannot grow unbounded even in a flood of simultaneous returns.
const darkShipReturns = new Map();

/**
 * Vessels that returned after extended AIS silence and were seen again
 * within the last 10 minutes — the signal the retired client-side ais_gaps
 * baseline counted per browser session (#7574). Sightings are recorded at
 * ingestion (processPositionReportForSnapshot) because cleanupAggregates
 * prunes vesselHistory to the 30-minute DENSITY_WINDOW, which can never
 * span the 1-hour GAP_THRESHOLD.
 */
function countDarkShips(now = Date.now()) {
  let darkShipCount = 0;
  for (const [mmsi, seenAt] of darkShipReturns) {
    if (now - seenAt >= 10 * 60 * 1000) darkShipReturns.delete(mmsi);
    else darkShipCount++;
  }
  return darkShipCount;
}

function detectDisruptions() {
  const disruptions = [];
  const now = Date.now();

  // O(chokepoints) using pre-built spatial buckets instead of O(chokepoints × vessels)
  for (const chokepoint of CHOKEPOINTS) {
    const bucket = chokepointBuckets.get(chokepoint.name);
    const vesselCount = bucket ? bucket.size : 0;

    if (vesselCount >= 5) {
      const normalTraffic = chokepoint.radius * 10;
      const severity = vesselCount > normalTraffic * 1.5
        ? 'high'
        : vesselCount > normalTraffic
          ? 'elevated'
          : 'low';

      disruptions.push({
        id: `chokepoint-${chokepoint.name.toLowerCase().replace(/\s+/g, '-')}`,
        name: chokepoint.name,
        type: 'chokepoint_congestion',
        lat: chokepoint.lat,
        lon: chokepoint.lon,
        severity,
        changePct: normalTraffic > 0 ? Math.round((vesselCount / normalTraffic - 1) * 100) : 0,
        windowHours: 1,
        vesselCount,
        region: chokepoint.name,
        description: `${vesselCount} vessels in ${chokepoint.name}`,
      });
    }
  }

  const darkShipCount = countDarkShips(now);
  if (darkShipCount >= 1) {
    disruptions.push({
      id: 'global-gap-spike',
      name: 'AIS Gap Spike Detected',
      type: 'gap_spike',
      lat: 0,
      lon: 0,
      severity: darkShipCount > 20 ? 'high' : darkShipCount > 10 ? 'elevated' : 'low',
      changePct: darkShipCount * 10,
      windowHours: 1,
      darkShips: darkShipCount,
      description: `${darkShipCount} vessels returned after extended AIS silence`,
    });
  }

  return disruptions;
}

function calculateDensityZones() {
  const zones = [];
  const allCells = Array.from(densityGrid.values()).filter((c) => c.vessels.size >= 2);
  if (allCells.length === 0) return zones;

  const vesselCounts = allCells.map((c) => c.vessels.size);
  const maxVessels = Math.max(...vesselCounts);
  const minVessels = Math.min(...vesselCounts);

  for (const [key, cell] of densityGrid) {
    if (cell.vessels.size < 2) continue;

    const logMax = Math.log(maxVessels + 1);
    const logMin = Math.log(minVessels + 1);
    const logCurrent = Math.log(cell.vessels.size + 1);

    const intensity = logMax > logMin
      ? 0.2 + (0.8 * (logCurrent - logMin) / (logMax - logMin))
      : 0.5;

    const deltaPct = cell.previousCount > 0
      ? Math.round(((cell.vessels.size - cell.previousCount) / cell.previousCount) * 100)
      : 0;

    zones.push({
      id: `density-${key}`,
      name: `Zone ${key}`,
      lat: cell.lat,
      lon: cell.lon,
      intensity,
      deltaPct,
      shipsPerDay: cell.vessels.size * 48,
      note: cell.vessels.size >= 10 ? 'High traffic area' : undefined,
    });
  }

  return zones
    .sort((a, b) => b.intensity - a.intensity)
    .slice(0, MAX_DENSITY_ZONES);
}

function getCandidateReportsSnapshot() {
  return Array.from(candidateReports.values())
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, MAX_CANDIDATE_REPORTS);
}

// Server-side cap for tanker_reports per request — protects the response
// payload from a misbehaving filter that returns thousands of vessels.
// 200/zone × 6 chokepoints in worst case is well under any practical
// CDN/edge payload budget. Energy Atlas live-tanker layer also caps
// client-side on top of this.
const MAX_TANKER_REPORTS_PER_RESPONSE = 200;

/**
 * Parse a "bbox" query param of the form "swLat,swLon,neLat,neLon" into a
 * {sw: {lat, lon}, ne: {lat, lon}} or null if absent / malformed.
 *
 * Validates:
 *   - 4 comma-separated finite numbers
 *   - sw <= ne (after normalization)
 *   - bbox size ≤ 10° on both lat and lon (10° max per parity-push plan U7;
 *     prevents pulling every vessel through one query)
 *
 * @param {string | null | undefined} raw
 * @returns {{ sw: {lat:number, lon:number}, ne: {lat:number, lon:number} } | null}
 */
function parseBbox(raw) {
  if (!raw) return null;
  const parts = String(raw).split(',').map(Number);
  if (parts.length !== 4 || parts.some((v) => !Number.isFinite(v))) return null;
  const [swLat, swLon, neLat, neLon] = parts;
  if (swLat > neLat || swLon > neLon) return null;
  if (swLat < -90 || neLat > 90 || swLon < -180 || neLon > 180) return null;
  if (neLat - swLat > 10 || neLon - swLon > 10) return null; // 10° guard
  return { sw: { lat: swLat, lon: swLon }, ne: { lat: neLat, lon: neLon } };
}

/**
 * Filtered + capped tanker reports. Sorted by recency of last fix so the
 * 200-cap keeps the most-recently-seen vessels rather than a random subset.
 *
 * @param {{ sw: {lat:number,lon:number}, ne: {lat:number,lon:number} } | null} bbox
 */
function getTankerReportsSnapshot(bbox) {
  let arr = Array.from(tankerReports.values());
  if (bbox) {
    arr = arr.filter(
      (r) => r.lat >= bbox.sw.lat && r.lat <= bbox.ne.lat &&
             r.lon >= bbox.sw.lon && r.lon <= bbox.ne.lon,
    );
  }
  arr.sort((a, b) => b.timestamp - a.timestamp);
  return arr.slice(0, MAX_TANKER_REPORTS_PER_RESPONSE);
}

function buildSnapshot() {
  const now = Date.now();
  const aisPositionFreshness = getAisPositionFreshness(now);
  // `positionStale` is part of the cache key: a feed that goes silent without yet
  // crossing the recycle budget must still flip the published status, otherwise
  // the stale verdict would sit behind a cached healthy snapshot.
  if (lastSnapshot
      && lastSnapshot.status.currentPositionReady === aisPositionFreshness.currentPositionReady
      && lastSnapshot.status.positionStale === aisPositionFreshness.positionStale
      && now - lastSnapshotAt < Math.floor(SNAPSHOT_INTERVAL_MS / 2)) {
    return lastSnapshot;
  }

  cleanupAggregates();
  snapshotSequence++;

  lastSnapshot = {
    sequence: snapshotSequence,
    timestamp: new Date(now).toISOString(),
    status: {
      connected: upstreamSocket?.readyState === WebSocket.OPEN,
      currentPositionReady: aisPositionFreshness.currentPositionReady,
      positionStale: aisPositionFreshness.positionStale,
      vessels: vessels.size,
      messages: messageCount,
      clients: 0,
      droppedMessages,
    },
    disruptions: detectDisruptions(),
    density: calculateDensityZones(),
  };
  lastSnapshotAt = now;

  // Pre-serialize JSON once (avoid per-request JSON.stringify)
  const basePayload = { ...lastSnapshot, candidateReports: [] };
  lastSnapshotJson = JSON.stringify(basePayload);

  const withCandPayload = { ...lastSnapshot, candidateReports: getCandidateReportsSnapshot() };
  lastSnapshotWithCandJson = JSON.stringify(withCandPayload);

  // Pre-compress both variants asynchronously (zero CPU on request path)
  const baseBuf = Buffer.from(lastSnapshotJson);
  const candBuf = Buffer.from(lastSnapshotWithCandJson);
  const compressionSequence = snapshotSequence;
  lastSnapshotGzip = null;
  lastSnapshotWithCandGzip = null;
  lastSnapshotBrotli = null;
  lastSnapshotWithCandBrotli = null;
  zlib.gzip(baseBuf, (err, buf) => {
    if (!err && snapshotSequence === compressionSequence) lastSnapshotGzip = buf;
  });
  zlib.gzip(candBuf, (err, buf) => {
    if (!err && snapshotSequence === compressionSequence) lastSnapshotWithCandGzip = buf;
  });
  zlib.brotliCompress(baseBuf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, (err, buf) => {
    if (!err && snapshotSequence === compressionSequence) lastSnapshotBrotli = buf;
  });
  zlib.brotliCompress(candBuf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }, (err, buf) => {
    if (!err && snapshotSequence === compressionSequence) lastSnapshotWithCandBrotli = buf;
  });

  return lastSnapshot;
}

function recordAisSnapshotAvailability(snapshot) {
  const connected = snapshot?.status?.connected === true;
  // messageCount is process-lifetime telemetry, not current snapshot coverage.
  // Only an actually served vessel set keeps the maritime surface available.
  const hasData = Number(snapshot?.status?.vessels) > 0;
  if (connected && snapshot?.status?.currentPositionReady === true && hasData) {
    recordRelayOutcome('aisSnapshot', 'success');
    incrementRelayMetric('aisSnapshotServed');
    return 'fresh';
  }
  if (hasData) {
    recordRelayOutcome('aisSnapshot', 'fallback');
    incrementRelayMetric('aisSnapshotServed');
    return 'stale';
  }
  recordRelayOutcome('aisSnapshot', 'terminalFailure');
  return 'unavailable';
}

setInterval(() => {
  if (upstreamSocket?.readyState === WebSocket.OPEN || vessels.size > 0) {
    buildSnapshot();
  }
}, SNAPSHOT_INTERVAL_MS).unref?.();

async function seedChokepointTransits() {
  const now = Date.now();
  const unavailable = await transitTracker.flush(now);
  if (unavailable.size) console.warn(`[Transit] Capacity-limited waterways: ${[...unavailable].join(', ')}`);
  const window = await readTransitWindow(chokepointCrossings, now, upstashEval);
  const transits = {};
  for (const cp of CHOKEPOINTS) {
    const recent = unavailable.has(cp.name) ? [] : window.get(cp.name) || [];
    // An empty observed window cannot establish zero traffic.
    transits[cp.name] = {
      tanker: recent.filter(c => c.type === 'tanker').length,
      cargo: recent.filter(c => c.type === 'cargo').length,
      other: recent.filter(c => c.type === 'other').length,
      total: recent.length,
      available: recent.length > 0,
    };
  }
  const canonical = Object.entries(RELAY_NAME_TO_ID).filter(([, id]) => id);
  const missing = canonical.filter(([name]) => !transits[name].available).map(([, id]) => id);
  const covered = canonical.length - missing.length;
  const transitCoverage = { covered, total: canonical.length, missing };
  const payload = { transits, transitCoverage, fetchedAt: now };
  const ok = await envelopeWrite(CHOKEPOINT_TRANSIT_KEY, payload, CHOKEPOINT_TRANSIT_TTL, { recordCount: covered, sourceVersion: 'chokepoint-transits' });
  if (!ok) throw new Error('Transit count publication failed');
  // Health names the measurable straits from this transitCoverage, so a dropped
  // write must fail the tick instead of leaving the previous coverage in place.
  const metaOk = await upstashSet('seed-meta:supply_chain:chokepoint_transits', { fetchedAt: now, recordCount: covered, transitCoverage }, 604800);
  if (!metaOk) throw new Error('Transit coverage metadata write failed');
  console.log(`[Transit] Seeded ${covered}/${canonical.length} measured chokepoints (missing: ${missing.join(', ')})`);
}

/**
 * seedAisGaps publishes the dark-ship count envelope + seed-meta.
 *
 * `sampledAt` is the content clock the temporal-anomalies rebuild reads
 * (gapsContentClock); computing `now` once and threading it through both
 * writes keeps `_seed.fetchedAt` and seed-meta in agreement (#6775).
 *
 * The publish is gated on AIS position freshness: while the aisstream feed
 * is down or stale the relay cannot observe returns, so publishing a count
 * (most robusly a zero) would stamp OK on a blind sensor. Skipping BOTH
 * writes instead lets the 30min health budget age the missing stamp into
 * STALE_SEED — the honest signal.
 */
async function seedAisGaps() {
  const now = Date.now();
  if (!getAisPositionFreshness(now).currentPositionReady) {
    console.log(`[AisGaps] Skipping publish: AIS positions not fresh (ageMs=${getAisPositionFreshness(now).positionAgeMs})`);
    return;
  }
  const darkShips = countDarkShips(now);
  const envelopeOk = await envelopeWrite(AIS_GAPS_REDIS_KEY, { darkShips, sampledAt: now }, AIS_GAPS_TTL, { fetchedAt: now, recordCount: darkShips, sourceVersion: 'ais-gaps', zeroOk: true });
  const metaOk = await upstashSet('seed-meta:maritime:ais-gaps', { fetchedAt: now, recordCount: darkShips }, 604800);
  if (!envelopeOk || !metaOk) {
    console.warn(`[AisGaps] Seed write FAILED (envelope=${envelopeOk} meta=${metaOk})`);
    return;
  }
  console.log(`[AisGaps] Seeded dark-ship count: ${darkShips}`);
}

setTimeout(() => {
  startBootSeedLoop('AisGaps', 'seed-meta:maritime:ais-gaps', AIS_GAPS_SEED_INTERVAL_MS, seedAisGaps, err => console.error('[AisGaps] Initial seed error:', err.message), err => console.error('[AisGaps] Seed error:', err.message));
}, 30_000);

setTimeout(() => {
  startBootSeedLoop('Transit', 'seed-meta:supply_chain:chokepoint_transits', CHOKEPOINT_TRANSIT_INTERVAL_MS, seedChokepointTransits, err => console.error('[Transit] Initial seed error:', err.message), err => console.error('[Transit] Seed error:', err.message));
}, 30_000);

// ID mapping: relay geofence name -> canonical ID
const RELAY_NAME_TO_ID = {
  'Suez Canal': 'suez', 'Malacca Strait': 'malacca_strait',
  'Strait of Hormuz': 'hormuz_strait', 'Bab el-Mandeb Strait': 'bab_el_mandeb',
  'Panama Canal': 'panama', 'Taiwan Strait': 'taiwan_strait',
  'Cape of Good Hope': 'cape_of_good_hope', 'Gibraltar Strait': 'gibraltar',
  'Bosporus Strait': 'bosphorus', 'Korea Strait': 'korea_strait',
  'Dover Strait': 'dover_strait', 'Kerch Strait': 'kerch_strait',
  'Lombok Strait': 'lombok_strait',
  'South China Sea': null, 'Black Sea': null, // area geofences, not chokepoints
};

// UCDP GED Events cache (persistent in-memory — Railway advantage). This relay
// reader can fetch more pages than the Redis seed writer, but it intentionally
// shares the same 365-day UCDP_TRAILING_WINDOW_MS filter.
const UCDP_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

 // 6 hours
const UCDP_RELAY_MAX_PAGES = 12;

const UCDP_FETCH_TIMEOUT = 30000;

 // 30s per page (no Railway limit)

let ucdpCache = { data: null, timestamp: 0 };

let ucdpFetchInProgress = false;

const UCDP_RELAY_VIOLENCE_TYPE_MAP = {
  1: 'state-based',
  2: 'non-state',
  3: 'one-sided',
};

function ucdpParseDateMs(value) {
  if (!value) return NaN;
  return Date.parse(String(value));
}

function ucdpGetMaxDateMs(events) {
  let maxMs = NaN;
  for (const event of events) {
    const ms = ucdpParseDateMs(event?.date_start);
    if (!Number.isFinite(ms)) continue;
    if (!Number.isFinite(maxMs) || ms > maxMs) maxMs = ms;
  }
  return maxMs;
}

function ucdpBuildVersionCandidates() {
  const year = new Date().getFullYear() - 2000;
  return Array.from(new Set([`${year}.1`, `${year - 1}.1`, '25.1', '24.1']));
}

async function ucdpRelayFetchPage(version, page) {
  const url = `https://ucdpapi.pcr.uu.se/api/gedevents/${version}?pagesize=${UCDP_PAGE_SIZE}&page=${page}`;

  return new Promise((resolve, reject) => {
    const req = https.get(url, { signal: AbortSignal.timeout(UCDP_FETCH_TIMEOUT), headers: { Accept: 'application/json' }, timeout: UCDP_FETCH_TIMEOUT }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`UCDP API ${res.statusCode} (v${version} p${page})`));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('UCDP JSON parse error')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('UCDP timeout')); });
  });
}

async function ucdpRelayDiscoverVersion() {
  // Candidates are newest-first ([26.1, 25.1, 24.1]); take the newest version that
  // actually returns events. Require Result.length > 0 (not just isArray) so a
  // newer release that exists but is still empty doesn't win over a populated
  // older one — same recency concern as ucdpDiscoverVersion above.
  const candidates = ucdpBuildVersionCandidates();
  for (const version of candidates) {
    try {
      const page0 = await ucdpRelayFetchPage(version, 0);
      if (Array.isArray(page0?.Result) && page0.Result.length > 0) return { version, page0 };
    } catch { /* next candidate */ }
  }
  throw new Error('No valid UCDP GED version found');
}

async function ucdpFetchAllEvents() {
  const { version, page0 } = await ucdpRelayDiscoverVersion();
  const totalPages = Math.max(1, Number(page0?.TotalPages) || 1);
  const newestPage = totalPages - 1;

  let allEvents = [];
  let latestDatasetMs = NaN;

  for (let offset = 0; offset < UCDP_RELAY_MAX_PAGES && (newestPage - offset) >= 0; offset++) {
    const page = newestPage - offset;
    const rawData = page === 0 ? page0 : await ucdpRelayFetchPage(version, page);
    const events = Array.isArray(rawData?.Result) ? rawData.Result : [];
    allEvents = allEvents.concat(events);

    const pageMaxMs = ucdpGetMaxDateMs(events);
    if (!Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      latestDatasetMs = pageMaxMs;
    }
    if (Number.isFinite(latestDatasetMs) && Number.isFinite(pageMaxMs)) {
      if (pageMaxMs < latestDatasetMs - UCDP_TRAILING_WINDOW_MS) break;
    }
    console.log(`[UCDP] Fetched v${version} page ${page} (${events.length} events)`);
  }

  const sanitized = allEvents
    .filter(e => {
      if (!Number.isFinite(latestDatasetMs)) return true;
      const ms = ucdpParseDateMs(e?.date_start);
      return Number.isFinite(ms) && ms >= (latestDatasetMs - UCDP_TRAILING_WINDOW_MS);
    })
    .map(e => ({
      id: String(e.id || ''),
      date_start: e.date_start || '',
      date_end: e.date_end || '',
      latitude: Number(e.latitude) || 0,
      longitude: Number(e.longitude) || 0,
      country: e.country || '',
      side_a: (e.side_a || '').substring(0, 200),
      side_b: (e.side_b || '').substring(0, 200),
      deaths_best: Number(e.best) || 0,
      deaths_low: Number(e.low) || 0,
      deaths_high: Number(e.high) || 0,
      type_of_violence: UCDP_RELAY_VIOLENCE_TYPE_MAP[e.type_of_violence] || 'state-based',
      source_original: (e.source_original || '').substring(0, 300),
    }))
    .sort((a, b) => {
      const bMs = ucdpParseDateMs(b.date_start);
      const aMs = ucdpParseDateMs(a.date_start);
      return (Number.isFinite(bMs) ? bMs : 0) - (Number.isFinite(aMs) ? aMs : 0);
    });

  return {
    success: true,
    count: sanitized.length,
    data: sanitized,
    version,
    cached_at: new Date().toISOString(),
  };
}

async function handleUcdpEventsRequest(req, res) {
  const now = Date.now();

  if (ucdpCache.data && now - ucdpCache.timestamp < UCDP_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600',
      'X-Cache': 'HIT',
    }, JSON.stringify(ucdpCache.data));
  }

  if (ucdpCache.data && !ucdpFetchInProgress) {
    ucdpFetchInProgress = true;
    ucdpFetchAllEvents()
      .then(result => {
        ucdpCache = { data: result, timestamp: Date.now() };
        console.log(`[UCDP] Background refresh: ${result.count} events (v${result.version})`);
      })
      .catch(err => console.error('[UCDP] Background refresh error:', err.message))
      .finally(() => { ucdpFetchInProgress = false; });

    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
      'CDN-Cache-Control': 'public, max-age=600',
      'X-Cache': 'STALE',
    }, JSON.stringify(ucdpCache.data));
  }

  if (ucdpFetchInProgress) {
    res.writeHead(202, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ success: false, count: 0, data: [], cached_at: '', message: 'Fetch in progress' }));
  }

  try {
    ucdpFetchInProgress = true;
    console.log('[UCDP] Cold fetch starting...');
    const result = await ucdpFetchAllEvents();
    ucdpCache = { data: result, timestamp: Date.now() };
    ucdpFetchInProgress = false;
    console.log(`[UCDP] Cold fetch complete: ${result.count} events (v${result.version})`);

    sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'CDN-Cache-Control': 'public, max-age=3600',
      'X-Cache': 'MISS',
    }, JSON.stringify(result));
  } catch (err) {
    ucdpFetchInProgress = false;
    console.error('[UCDP] Fetch error:', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: err.message, count: 0, data: [] }));
  }
}

// ── Response caches (eliminates ~1.2TB/day OpenSky + ~30GB/day RSS egress) ──
const openskyResponseCache = new Map();

 // key: sorted query params → { data, gzip, timestamp }
const openskyNegativeCache = new Map();

 // key: cacheKey → { status, timestamp, body, gzip } — prevents retry storms on 429/5xx
const openskyInFlight = new Map();

 // key: cacheKey → Promise (dedup concurrent requests)
// 180s default — env-configurable. This TTL is the only thing standing between the
// dashboard's poll rate and a PAID upstream fetch: OpenSky is 82.5% of the residential
// proxy bill (24.86 GB / $136.75 of a ~$165 quarter, per Decodo's per-target report),
// and it serves /states/all UNCOMPRESSED — identity, gzip, deflate and br all return
// the same ~1.49 MB, so no Accept-Encoding change can shrink a miss. Fetching less
// often is the entire lever, hence 60s → 180s. NOTE: production overrides this with
// OPENSKY_CACHE_TTL_MS on the ais-relay service, so raising the default alone changes
// nothing in prod — the env var has to move with it. The client-facing Cache-Control
// stays at 30s so browsers keep revalidating against this in-memory cache, which is
// free, instead of pinning a 180s-stale copy of their own.
const OPENSKY_CACHE_TTL_MS = Number(process.env.OPENSKY_CACHE_TTL_MS) || 180 * 1000;

const OPENSKY_NEGATIVE_CACHE_TTL_MS = Number(process.env.OPENSKY_NEGATIVE_CACHE_TTL_MS) || 30 * 1000;

 // 30s — env-configurable
const OPENSKY_CACHE_MAX_ENTRIES = Math.max(10, Number(process.env.OPENSKY_CACHE_MAX_ENTRIES || 128));

const OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES = Math.max(10, Number(process.env.OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES || 256));

const OPENSKY_BBOX_QUANT_STEP = Number.isFinite(Number(process.env.OPENSKY_BBOX_QUANT_STEP))
  ? Math.max(0, Number(process.env.OPENSKY_BBOX_QUANT_STEP)) : 0.01;

const OPENSKY_BBOX_DECIMALS = OPENSKY_BBOX_QUANT_STEP > 0
  ? Math.min(6, ((String(OPENSKY_BBOX_QUANT_STEP).split('.')[1] || '').length || 0))
  : 6;

const OPENSKY_DEDUP_EMPTY_RESPONSE_JSON = JSON.stringify({ states: [], time: 0 });

const OPENSKY_DEDUP_EMPTY_RESPONSE_GZIP = gzipSyncBuffer(OPENSKY_DEDUP_EMPTY_RESPONSE_JSON);

const OPENSKY_DEDUP_EMPTY_RESPONSE_BROTLI = brotliSyncBuffer(OPENSKY_DEDUP_EMPTY_RESPONSE_JSON);

const rssResponseCache = new Map();

 // key: feed URL → last successful { data, contentType, timestamp, statusCode }
const rssNegativeCache = new Map();

 // key: feed URL → short-lived last non-2xx response
const rssInFlight = new Map();

 // key: feed URL → Promise (dedup concurrent requests)
const rssFailureCount = new Map();

 // key: feed URL → consecutive failure count (for exponential backoff)
const rssBackoffUntil = new Map();

 // key: feed URL → timestamp when backoff expires
const RSS_CACHE_TTL_MS = Math.max(1, Number(process.env.RELAY_TEST_RSS_CACHE_TTL_MS) || 5 * 60 * 1000);

 // 5 min — RSS feeds rarely update faster
const RSS_NEGATIVE_CACHE_TTL_MS = 60 * 1000;

 // 1 min base — scaled by 2^failures via backoff
const RSS_MAX_NEGATIVE_CACHE_TTL_MS = 15 * 60 * 1000;

 // 15 min cap — stop hammering broken feeds
const RSS_CACHE_MAX_ENTRIES = 200;

 // hard cap — ~20 allowed domains × ~5 paths max, with headroom
const RSS_NEGATIVE_CACHE_MAX_ENTRIES = 64;

 // short-lived failures need less headroom than feed bodies
const RSS_CACHE_CLEANUP_INTERVAL_MS = Math.max(1, Number(process.env.RELAY_TEST_RSS_CACHE_CLEANUP_INTERVAL_MS) || 60 * 1000);

function rssRecordFailure(feedUrl) {
  const prev = rssFailureCount.get(feedUrl) || 0;
  const ttl = nextBackoffMs(prev, RSS_NEGATIVE_CACHE_TTL_MS, RSS_MAX_NEGATIVE_CACHE_TTL_MS);
  rssFailureCount.set(feedUrl, prev + 1);
  rssBackoffUntil.set(feedUrl, Date.now() + ttl);
  return { failures: prev + 1, backoffSec: Math.round(ttl / 1000) };
}

function rssResetFailure(feedUrl) {
  rssFailureCount.delete(feedUrl);
  rssBackoffUntil.delete(feedUrl);
}

function setBoundedCacheEntry(cache, key, value, maxEntries) {
  if (!cache.has(key) && cache.size >= maxEntries) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function touchCacheEntry(cache, key, entry) {
  cache.delete(key);
  cache.set(key, entry);
}

function cacheOpenSkyPositive(cacheKey, data) {
  setBoundedCacheEntry(openskyResponseCache, cacheKey, {
    data,
    gzip: gzipSyncBuffer(data),
    brotli: brotliSyncBuffer(data),
    timestamp: Date.now(),
  }, OPENSKY_CACHE_MAX_ENTRIES);
}

function cacheOpenSkyNegative(cacheKey, status) {
  const now = Date.now();
  const body = JSON.stringify({ states: [], time: now });
  setBoundedCacheEntry(openskyNegativeCache, cacheKey, {
    status,
    timestamp: now,
    body,
    gzip: gzipSyncBuffer(body),
    brotli: brotliSyncBuffer(body),
  }, OPENSKY_NEGATIVE_CACHE_MAX_ENTRIES);
}

function quantizeCoordinate(value) {
  if (!OPENSKY_BBOX_QUANT_STEP) return value;
  return Math.round(value / OPENSKY_BBOX_QUANT_STEP) * OPENSKY_BBOX_QUANT_STEP;
}

function formatCoordinate(value) {
  return Number(value.toFixed(OPENSKY_BBOX_DECIMALS)).toString();
}

function normalizeOpenSkyBbox(params) {
  const keys = ['lamin', 'lomin', 'lamax', 'lomax'];
  const hasAny = keys.some(k => params.has(k));
  if (!hasAny) {
    return { cacheKey: ',,,', queryParams: [] };
  }
  if (!keys.every(k => params.has(k))) {
    return { error: 'Provide all bbox params: lamin,lomin,lamax,lomax' };
  }

  const values = {};
  for (const key of keys) {
    const raw = params.get(key);
    if (raw === null || raw.trim() === '') return { error: `Invalid ${key} value` };
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return { error: `Invalid ${key} value` };
    values[key] = parsed;
  }

  if (values.lamin < -90 || values.lamax > 90 || values.lomin < -180 || values.lomax > 180) {
    return { error: 'Bbox out of range' };
  }
  if (values.lamin > values.lamax || values.lomin > values.lomax) {
    return { error: 'Invalid bbox ordering' };
  }

  const normalized = {};
  for (const key of keys) normalized[key] = formatCoordinate(quantizeCoordinate(values[key]));
  return {
    cacheKey: keys.map(k => normalized[k]).join(','),
    queryParams: keys.map(k => `${k}=${encodeURIComponent(normalized[k])}`),
  };
}

// OpenSky OAuth2 token cache + mutex to prevent thundering herd
let openskyToken = null;

let openskyTokenExpiry = 0;

let openskyTokenPromise = null;

 // mutex: single in-flight token request
let openskyAuthCooldownUntil = 0;

 // backoff after repeated failures
const OPENSKY_AUTH_COOLDOWN_MS = 60000;

 // 1 min cooldown after auth failure

// Global OpenSky rate limiter — serializes upstream requests and enforces 429 cooldown
let openskyGlobal429Until = 0;

 // timestamp: block ALL upstream requests until this time
const OPENSKY_429_COOLDOWN_MS = Number(process.env.OPENSKY_429_COOLDOWN_MS) || 90 * 1000;

 // 90s cooldown after any 429
const OPENSKY_MAX_429_COOLDOWN_MS = OPENSKY_MAX_COOLDOWN_MS;

const OPENSKY_REQUEST_SPACING_MS = Number(process.env.OPENSKY_REQUEST_SPACING_MS) || 2000;

 // 2s minimum between consecutive upstream requests
let openskyLastUpstreamTime = 0;

let openskyUpstreamQueue = Promise.resolve();

 // serial chain — only 1 upstream request at a time
let openskyRateLimitRemaining = null;

let openskyLastSuccessAt = 0;

let openskyLast429At = 0;

function mergeLocalOpenSkyCooldown(untilMs) {
  if (!Number.isFinite(untilMs) || untilMs <= Date.now()) return;
  openskyGlobal429Until = Math.max(openskyGlobal429Until, untilMs);
}

// Aviation bbox callers abort this relay hop after 6s
// (track-aircraft BBOX_RELAY_TIMEOUT_MS). Bound the shared Redis GET so a
// slow read still fails open with enough time for OpenSky. Deduplicate only
// while the read is in flight: a completed zero must not hide a cooldown that
// the seeder writes before the queued upstream boundary (#6253).
const OPENSKY_SHARED_COOLDOWN_READ_TIMEOUT_MS = 1_000;

let sharedOpenSkyCooldownReadPromise = null;

async function readLegacySharedOpenSkyCooldownMs() {
  const record = await upstashGet(OPENSKY_LEGACY_COOLDOWN_KEY, (reason) => {
    console.warn('[Relay] OpenSky legacy cooldown read failed, proceeding without it: ' + reason);
  }, OPENSKY_SHARED_COOLDOWN_READ_TIMEOUT_MS);
  const inspected = inspectCooldownRecord(record, {
    account: OPENSKY_ACCOUNT_FINGERPRINT,
  });
  if (inspected.ignoreReason === 'account-mismatch') {
    console.warn('[Relay] OpenSky legacy cooldown ignored — recorded for a different account');
  } else if (inspected.ignoreReason === 'implausible-deadline') {
    console.warn('[Relay] OpenSky legacy cooldown ignored — implausible deadline ' + inspected.until);
  }
  if (inspected.remainingMs <= 0) return 0;

  // Copy, never delete: a rolling deploy can still have v1 writers. The
  // account-scoped max-deadline EVAL protects a concurrent v2 writer.
  try {
    const command = maxDeadlineSetCommand(
      OPENSKY_COOLDOWN_KEY,
      record,
      ttlSecondsForCooldown(inspected.remainingMs),
    );
    const written = await upstashEval(
      OPENSKY_MAX_DEADLINE_SET_LUA,
      [OPENSKY_COOLDOWN_KEY],
      command.slice(4),
    );
    if (written == null && UPSTASH_ENABLED) {
      console.warn('[Relay] OpenSky legacy cooldown migration returned non-OK');
    }
  } catch (err) {
    console.warn('[Relay] OpenSky legacy cooldown migration failed, proceeding with the observed cooldown: ' + (err.message || err));
  }
  return inspected.remainingMs;
}

// Shared Redis record written by this relay and by seed-military-flights.
// Fails OPEN on every error path: a Redis problem must never disable the
// data tier, and the in-process cooldown still works when Redis is down (#6253).
async function remainingSharedOpenSkyCooldownMs() {
  if (sharedOpenSkyCooldownReadPromise) return sharedOpenSkyCooldownReadPromise;

  const pending = readSharedOpenSkyCooldownMs();
  sharedOpenSkyCooldownReadPromise = pending;
  try {
    return await pending;
  } finally {
    if (sharedOpenSkyCooldownReadPromise === pending) {
      sharedOpenSkyCooldownReadPromise = null;
    }
  }
}

async function readSharedOpenSkyCooldownMs() {
  try {
    let v2ReadFailed = false;
    const record = await upstashGet(OPENSKY_COOLDOWN_KEY, (reason) => {
      v2ReadFailed = true;
      console.warn(`[Relay] OpenSky shared cooldown read failed, proceeding without it: ${reason}`);
    }, OPENSKY_SHARED_COOLDOWN_READ_TIMEOUT_MS);
    const inspected = inspectCooldownRecord(record, {
      account: OPENSKY_ACCOUNT_FINGERPRINT,
    });
    if (inspected.ignoreReason === 'account-mismatch') {
      console.warn('[Relay] OpenSky shared cooldown ignored — recorded for a different account');
    } else if (inspected.ignoreReason === 'implausible-deadline') {
      console.warn(`[Relay] OpenSky shared cooldown ignored — implausible deadline ${inspected.until}`);
    }
    if (inspected.remainingMs > 0) {
      mergeLocalOpenSkyCooldown(Date.now() + inspected.remainingMs);
      return inspected.remainingMs;
    }
    // A v2 transport or parse failure must remain fail-open. Only a clean
    // empty, expired, or mismatched v2 read may consult the legacy key.
    if (v2ReadFailed) return 0;
    if (!legacyCooldownCompatibilityEnabled()) return 0;
    const legacyRemainingMs = await readLegacySharedOpenSkyCooldownMs();
    if (legacyRemainingMs > 0) {
      mergeLocalOpenSkyCooldown(Date.now() + legacyRemainingMs);
    }
    return legacyRemainingMs;
  } catch (err) {
    console.warn(`[Relay] OpenSky shared cooldown read failed, proceeding without it: ${err.message || err}`);
    return 0;
  }
}

async function persistSharedOpenSkyCooldown(retryAfterSeconds, completedAt = Date.now()) {
  const localCooldownMs = clampCooldownMs(retryAfterSeconds, OPENSKY_429_COOLDOWN_MS);
  mergeLocalOpenSkyCooldown(completedAt + localCooldownMs);
  // The in-process limiter can stay short (90s). The shared record must
  // outlive the seeder's */5 tick, so header-less 429s use the 10-minute
  // persist fallback instead of the relay's local default (#6253).
  const persistCooldownMs = clampCooldownMs(retryAfterSeconds, OPENSKY_SHARED_FALLBACK_COOLDOWN_MS);
  const record = buildCooldownRecord({
    now: completedAt,
    cooldownMs: persistCooldownMs,
    retryAfterSeconds,
    account: OPENSKY_ACCOUNT_FINGERPRINT,
    recordedBy: 'ais-relay',
  });
  try {
    // During the bounded rollout bridge, one EVAL updates the account-scoped
    // key and v1 atomically so an old process cannot miss a new lockout.
    // After the cutoff, only v2 remains on the hot path.
    const keys = legacyCooldownCompatibilityEnabled({ now: completedAt })
      ? [OPENSKY_COOLDOWN_KEY, OPENSKY_LEGACY_COOLDOWN_KEY]
      : [OPENSKY_COOLDOWN_KEY];
    const command = maxDeadlineSetCommand(
      keys,
      record,
      ttlSecondsForCooldown(persistCooldownMs),
    );
    const written = await upstashEval(
      OPENSKY_MAX_DEADLINE_SET_LUA,
      keys,
      command.slice(3 + keys.length),
    );
    if (written == null && UPSTASH_ENABLED) {
      console.warn('[Relay] OpenSky shared cooldown persist returned non-OK');
    }
  } catch (err) {
    console.warn(`[Relay] OpenSky shared cooldown persist failed: ${err.message || err}`);
  }
  return localCooldownMs;
}

async function getOpenSkyToken() {
  const clientId = process.env.OPENSKY_CLIENT_ID;
  const clientSecret = process.env.OPENSKY_CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    return null;
  }

  // Return cached token if still valid (with 60s buffer)
  if (openskyToken && Date.now() < openskyTokenExpiry - 60000) {
    return openskyToken;
  }

  // Cooldown: don't retry auth if it recently failed (prevents stampede)
  if (Date.now() < openskyAuthCooldownUntil) {
    return null;
  }

  // Mutex: if a token fetch is already in flight, wait for it
  if (openskyTokenPromise) {
    return openskyTokenPromise;
  }

  openskyTokenPromise = _fetchOpenSkyToken(clientId, clientSecret);
  try {
    return await openskyTokenPromise;
  } finally {
    openskyTokenPromise = null;
  }
}

function _openskyProxyConnect(targetHost, targetPort, timeoutMs = 10000) {
  if (!OPENSKY_PROXY_ENABLED) return Promise.resolve(null);
  const { proxyConnectTunnel, parseProxyConfig } = require('./_proxy-utils.cjs');
  const proxyConfig = parseProxyConfig(OPENSKY_PROXY_AUTH);
  if (!proxyConfig) return Promise.resolve(null);
  proxyConfig.tls = true; // Decodo always requires TLS; http:// scheme in PROXY_URL would set false
  return proxyConnectTunnel(targetHost, proxyConfig, { timeoutMs, targetPort })
    .then(({ socket }) => socket);
}

function _attemptOpenSkyTokenFetch(clientId, clientSecret) {
  const postData = `grant_type=client_credentials&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}`;
  const reqHeaders = {
    'Content-Type': 'application/x-www-form-urlencoded',
    'Content-Length': Buffer.byteLength(postData),
    'User-Agent': 'WorldMonitor/1.0',
  };

  if (OPENSKY_PROXY_ENABLED) {
    return _openskyProxyConnect('auth.opensky-network.org', 443).then((tlsSocket) => {
      return new Promise((resolve) => {
        const req = https.request({
          signal: AbortSignal.timeout(10000),
          // tlsSocket is ALREADY a TLS connection to the target — proxyConnectTunnel
          // does tls.connect() through the CONNECT tunnel. Reuse it via
          // createConnection (NOT `socket:`): `socket:` makes https.request wrap it
          // in a SECOND TLS layer → EPROTO "wrong version number" (double-TLS),
          // which fails every OpenSky auth attempt. Mirrors proxyFetch(). See #5074.
          createConnection: () => tlsSocket,
          // No agent means Node defaults to port 80 and sends `Host: <host>:80`
          // over TLS; the tunnel is to :443. Mirrors proxyFetch().
          defaultPort: 443,
          hostname: 'auth.opensky-network.org',
          path: '/auth/realms/opensky-network/protocol/openid-connect/token',
          method: 'POST',
          headers: reqHeaders,
          timeout: 10000,
        }, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              if (json.access_token) {
                resolve({ token: json.access_token, expiresIn: json.expires_in || 1800 });
              } else {
                resolve({ error: json.error || 'no_access_token', status: res.statusCode });
              }
            } catch (e) {
              resolve({ error: `parse: ${e.message}`, status: res.statusCode });
            }
          });
        });
        req.on('error', (err) => resolve({ error: `${err.code || 'UNKNOWN'}: ${err.message}` }));
        req.on('timeout', () => { req.destroy(); resolve({ error: 'TIMEOUT' }); });
        req.write(postData);
        req.end();
      });
    }).catch((err) => ({ error: `PROXY: ${err.message}` }));
  }

  return new Promise((resolve) => {
    const req = https.request({
      signal: AbortSignal.timeout(10000),
      hostname: 'auth.opensky-network.org',
      port: 443,
      family: 4,
      path: '/auth/realms/opensky-network/protocol/openid-connect/token',
      method: 'POST',
      headers: reqHeaders,
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.access_token) {
            resolve({ token: json.access_token, expiresIn: json.expires_in || 1800 });
          } else {
            resolve({ error: json.error || 'no_access_token', status: res.statusCode });
          }
        } catch (e) {
          resolve({ error: `parse: ${e.message}`, status: res.statusCode });
        }
      });
    });

    req.on('error', (err) => {
      resolve({ error: `${err.code || 'UNKNOWN'}: ${err.message}` });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ error: 'TIMEOUT' });
    });

    req.write(postData);
    req.end();
  });
}

const OPENSKY_AUTH_MAX_RETRIES = 3;

const OPENSKY_AUTH_RETRY_DELAYS = [0, 2000, 5000];

async function _fetchOpenSkyToken(clientId, clientSecret) {
  try {
    for (let attempt = 0; attempt < OPENSKY_AUTH_MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        const delay = OPENSKY_AUTH_RETRY_DELAYS[attempt] || 5000;
        console.log(`[Relay] OpenSky auth retry ${attempt + 1}/${OPENSKY_AUTH_MAX_RETRIES} in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.log('[Relay] Fetching new OpenSky OAuth2 token...');
      }

      const result = await _attemptOpenSkyTokenFetch(clientId, clientSecret);
      if (result.token) {
        openskyToken = result.token;
        openskyTokenExpiry = Date.now() + result.expiresIn * 1000;
        console.log('[Relay] OpenSky token acquired, expires in', result.expiresIn, 'seconds');
        return openskyToken;
      }
      console.error(`[Relay] OpenSky auth attempt ${attempt + 1} failed:`, result.error, result.status ? `(HTTP ${result.status})` : '');
    }

    openskyAuthCooldownUntil = Date.now() + OPENSKY_AUTH_COOLDOWN_MS;
    console.warn(`[Relay] OpenSky auth failed after ${OPENSKY_AUTH_MAX_RETRIES} attempts, cooling down for ${OPENSKY_AUTH_COOLDOWN_MS / 1000}s`);
    return null;
  } catch (err) {
    console.error('[Relay] OpenSky token error:', err.message);
    openskyAuthCooldownUntil = Date.now() + OPENSKY_AUTH_COOLDOWN_MS;
    return null;
  }
}

// Promisified upstream OpenSky fetch (single request)
function _collectDecompressed(response) {
  return new Promise((resolve, reject) => {
    const enc = (response.headers['content-encoding'] || '').trim().toLowerCase();
    let stream = response;
    if (enc === 'gzip' || enc === 'x-gzip') stream = response.pipe(zlib.createGunzip());
    else if (enc === 'deflate') stream = response.pipe(zlib.createInflate());
    else if (enc === 'br') stream = response.pipe(zlib.createBrotliDecompress());
    const chunks = [];
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString()));
    stream.on('error', (err) => reject(new Error(`decompression failed (${enc}): ${err.message}`)));
  });
}

function _readOpenSkyRateLimitHeaders(response) {
  const remaining = Number(response.headers['x-rate-limit-remaining']);
  const retryAfterSeconds = Number(response.headers['x-rate-limit-retry-after-seconds']);
  return {
    rateLimitRemaining: Number.isFinite(remaining) && remaining >= 0 ? Math.floor(remaining) : null,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? Math.min(Math.ceil(retryAfterSeconds), OPENSKY_MAX_429_COOLDOWN_MS / 1000)
      : null,
  };
}

function _openskyRawFetch(url, token) {
  const parsed = new URL(url);
  const reqHeaders = {
    'Accept': 'application/json',
    'Accept-Encoding': 'gzip, deflate, br',
    'User-Agent': 'WorldMonitor/1.0',
    'Authorization': `Bearer ${token}`,
  };

  if (OPENSKY_PROXY_ENABLED) {
    return _openskyProxyConnect(parsed.hostname, 443, 15000).then((tlsSocket) => {
      return new Promise((resolve) => {
        const request = https.get({
          signal: AbortSignal.timeout(15000),
          // Reuse the already-TLS tunnel socket via createConnection, not `socket:`
          // — passing an already-TLS socket as `socket:` double-wraps TLS and throws
          // EPROTO "wrong version number", failing every OpenSky states fetch. See #5074.
          createConnection: () => tlsSocket,
          // No agent means Node defaults to port 80 and sends `Host: <host>:80`
          // over TLS; the tunnel is to :443. Mirrors proxyFetch().
          defaultPort: 443,
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          headers: reqHeaders,
          timeout: 15000,
        }, (response) => {
          const rateLimit = _readOpenSkyRateLimitHeaders(response);
          _collectDecompressed(response)
            .then(data => resolve({ status: response.statusCode || 502, data, ...rateLimit }))
            .catch(err => resolve({ status: response.statusCode || 502, data: null, error: err, ...rateLimit }));
        });
        request.on('error', (err) => resolve({ status: 0, data: null, error: err }));
        request.on('timeout', () => { request.destroy(); resolve({ status: 504, data: null, error: new Error('timeout') }); });
      });
    }).catch((err) => ({ status: 0, data: null, error: new Error(`PROXY: ${err.message}`) }));
  }

  return new Promise((resolve) => {
    const request = https.get(url, {
      signal: AbortSignal.timeout(15000),
      family: 4,
      headers: reqHeaders,
      agent: httpsKeepAliveAgent,
      timeout: 15000,
    }, (response) => {
      const rateLimit = _readOpenSkyRateLimitHeaders(response);
      _collectDecompressed(response)
        .then(data => resolve({ status: response.statusCode || 502, data, ...rateLimit }))
        .catch(err => resolve({ status: response.statusCode || 502, data: null, error: err, ...rateLimit }));
    });
    request.on('error', (err) => resolve({ status: 0, data: null, error: err }));
    request.on('timeout', () => { request.destroy(); resolve({ status: 504, data: null, error: new Error('timeout') }); });
  });
}

// Serialized queue — ensures only 1 upstream request at a time with minimum spacing.
// Prevents 5 concurrent bbox queries from all getting 429'd.
function openskyQueuedFetch(url, token) {
  const job = openskyUpstreamQueue.then(async () => {
    if (Date.now() < openskyGlobal429Until) {
      return { status: 429, data: JSON.stringify({ states: [], time: Date.now() }), rateLimited: true };
    }
    const wait = OPENSKY_REQUEST_SPACING_MS - (Date.now() - openskyLastUpstreamTime);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    if (Date.now() < openskyGlobal429Until) {
      return { status: 429, data: JSON.stringify({ states: [], time: Date.now() }), rateLimited: true };
    }
    // Cross-process arming: a seeder 429 parked the shared Redis key while this
    // process still had a zero in-process deadline (#6253). Fail-open on Redis.
    if (await remainingSharedOpenSkyCooldownMs() > 0) {
      return { status: 429, data: JSON.stringify({ states: [], time: Date.now() }), rateLimited: true };
    }
    openskyLastUpstreamTime = Date.now();
    incrementRelayMetric('openskyUpstreamFetches');
    const result = await _openskyRawFetch(url, token);
    const completedAt = Date.now();
    if (result.rateLimitRemaining != null) {
      openskyRateLimitRemaining = result.rateLimitRemaining;
    }
    if (result.status >= 200 && result.status < 300) {
      openskyLastSuccessAt = completedAt;
    }
    if (result.status === 429) {
      const cooldownMs = await persistSharedOpenSkyCooldown(result.retryAfterSeconds, completedAt);
      openskyLast429At = completedAt;
      console.warn(`[Relay] OpenSky 429 — global cooldown ${Math.ceil(cooldownMs / 1000)}s (all bbox queries blocked)`);
    }
    return result;
  });
  openskyUpstreamQueue = job.catch(() => {});
  return job;
}

async function handleOpenSkyRequest(req, res, PORT) {
  let cacheKey = '';
  let settleFlight = null;
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const params = url.searchParams;
    const normalizedBbox = normalizeOpenSkyBbox(params);
    if (normalizedBbox.error) {
      return safeEnd(res, 400, { 'Content-Type': 'application/json' }, JSON.stringify({
        error: normalizedBbox.error,
        time: Date.now(),
        states: [],
      }));
    }

    cacheKey = normalizedBbox.cacheKey;
    incrementRelayMetric('openskyRequests');

    // 1. Check positive cache (30s TTL)
    const cached = openskyResponseCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < OPENSKY_CACHE_TTL_MS) {
      incrementRelayMetric('openskyCacheHit');
      incrementRelayMetric('openskyServed');
      touchCacheEntry(openskyResponseCache, cacheKey, cached); // LRU
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30',
        'CDN-Cache-Control': 'public, max-age=15',
        'X-Cache': 'HIT',
      }, cached.data, cached.gzip, cached.brotli);
    }

    // 2. Check negative cache — prevents retry storms when upstream returns 429/5xx
    const negCached = openskyNegativeCache.get(cacheKey);
    if (negCached && Date.now() - negCached.timestamp < OPENSKY_NEGATIVE_CACHE_TTL_MS) {
      incrementRelayMetric('openskyNegativeHit');
      recordRelayOutcome('opensky', classifyOpenSkyOutcome({ status: negCached.status }));
      touchCacheEntry(openskyNegativeCache, cacheKey, negCached); // LRU
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'NEG',
      }, negCached.body, negCached.gzip, negCached.brotli);
    }

    // 2b. Global 429 cooldown — blocks ALL bbox queries when OpenSky is rate-limiting.
    //     Without this, 5 unique bbox keys all fire simultaneously when neg cache expires,
    //     ALL get 429'd, and the cycle repeats forever with zero data flowing.
    //     Also honor a seeder-written Redis deadline so this process does not
    //     spend a doomed auth+data round-trip to rediscover the same lockout.
    if (Date.now() >= openskyGlobal429Until) {
      await remainingSharedOpenSkyCooldownMs();
    }
    if (Date.now() < openskyGlobal429Until) {
      incrementRelayMetric('openskyNegativeHit');
      recordRelayOutcome('opensky', 'throttle');
      cacheOpenSkyNegative(cacheKey, 429);
      const remainSec = Math.max(1, Math.ceil((openskyGlobal429Until - Date.now()) / 1000));
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'RATE-LIMITED',
        'Retry-After': String(remainSec),
      }, JSON.stringify({ states: [], time: Date.now() }));
    }

    // 3. Dedup concurrent requests — await in-flight and return result OR empty (never fall through)
    const existing = openskyInFlight.get(cacheKey);
    if (existing) {
      try {
        await existing;
      } catch { /* in-flight failed */ }
      const deduped = openskyResponseCache.get(cacheKey);
      if (deduped && Date.now() - deduped.timestamp < OPENSKY_CACHE_TTL_MS) {
        incrementRelayMetric('openskyDedup');
        incrementRelayMetric('openskyServed');
        touchCacheEntry(openskyResponseCache, cacheKey, deduped); // LRU
        return sendPreGzipped(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=30',
          'CDN-Cache-Control': 'public, max-age=15',
          'X-Cache': 'DEDUP',
        }, deduped.data, deduped.gzip, deduped.brotli);
      }
      const dedupNeg = openskyNegativeCache.get(cacheKey);
      if (dedupNeg && Date.now() - dedupNeg.timestamp < OPENSKY_NEGATIVE_CACHE_TTL_MS) {
        incrementRelayMetric('openskyDedupNeg');
        recordRelayOutcome('opensky', classifyOpenSkyOutcome({ status: dedupNeg.status }));
        touchCacheEntry(openskyNegativeCache, cacheKey, dedupNeg); // LRU
        return sendPreGzipped(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
          'CDN-Cache-Control': 'no-store',
          'X-Cache': 'DEDUP-NEG',
        }, dedupNeg.body, dedupNeg.gzip, dedupNeg.brotli);
      }
      // In-flight completed but no cache entry (upstream failed) — return empty instead of thundering herd
      incrementRelayMetric('openskyDedupEmpty');
      recordRelayOutcome('opensky', 'terminalFailure');
      return sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'DEDUP-EMPTY',
      }, OPENSKY_DEDUP_EMPTY_RESPONSE_JSON, OPENSKY_DEDUP_EMPTY_RESPONSE_GZIP, OPENSKY_DEDUP_EMPTY_RESPONSE_BROTLI);
    }

    incrementRelayMetric('openskyMiss');

    // 4. Set in-flight BEFORE async token fetch to prevent race window
    let resolveFlight;
    let flightSettled = false;
    const flightPromise = new Promise((resolve) => { resolveFlight = resolve; });
    settleFlight = () => {
      if (flightSettled) return;
      flightSettled = true;
      resolveFlight();
    };
    openskyInFlight.set(cacheKey, flightPromise);

    const token = await getOpenSkyToken();
    if (!token) {
      // Do NOT negative-cache auth failures — they poison ALL bbox keys.
      // Only negative-cache actual upstream 429/5xx responses.
      settleFlight();
      openskyInFlight.delete(cacheKey);
      recordRelayOutcome('opensky', 'authRejection');
      return safeEnd(res, 503, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'OpenSky not configured or auth failed', time: Date.now(), states: [] }));
    }

    let openskyUrl = 'https://opensky-network.org/api/states/all';
    if (normalizedBbox.queryParams.length > 0) {
      openskyUrl += '?' + normalizedBbox.queryParams.join('&');
    }

    logThrottled('log', `opensky-miss:${cacheKey}`, '[Relay] OpenSky request (MISS):', openskyUrl);
    // Serialized fetch — queued with spacing to prevent concurrent 429 storms
    const result = await openskyQueuedFetch(openskyUrl, token);
    const upstreamStatus = result.status || 502;
    const upstreamOutcome = result.error
      ? classifyOpenSkyOutcome({ status: upstreamStatus, error: result.error })
      : classifyOpenSkyOutcome({ status: upstreamStatus });
    recordRelayOutcome('opensky', upstreamOutcome);

    if (upstreamStatus === 401) {
      openskyToken = null;
      openskyTokenExpiry = 0;
    }

    if (upstreamStatus === 200 && result.data) {
      cacheOpenSkyPositive(cacheKey, result.data);
      openskyNegativeCache.delete(cacheKey);
      incrementRelayMetric('openskyServed');
    } else if (result.error) {
      logThrottled('error', `opensky-error:${cacheKey}:${result.error.code || result.error.message}`, '[Relay] OpenSky error:', result.error.message);
      cacheOpenSkyNegative(cacheKey, upstreamStatus || 500);
    } else {
      cacheOpenSkyNegative(cacheKey, upstreamStatus);
      logThrottled('warn', `opensky-upstream-${upstreamStatus}:${cacheKey}`,
        `[Relay] OpenSky upstream ${upstreamStatus} for ${openskyUrl}, negative-cached for ${OPENSKY_NEGATIVE_CACHE_TTL_MS / 1000}s`);
    }

    settleFlight();
    openskyInFlight.delete(cacheKey);

    // Serve stale cache on network errors
    if (result.error && cached) {
      incrementRelayMetric('openskyServed');
      recordRelayOutcome('opensky', 'fallback');
      return sendPreGzipped(req, res, 200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'CDN-Cache-Control': 'no-store', 'X-Cache': 'STALE' }, cached.data, cached.gzip, cached.brotli);
    }

    const responseData = result.data || JSON.stringify({ error: result.error?.message || 'upstream error', time: Date.now(), states: null });
    const responseHeaders = {
      'Content-Type': 'application/json',
      'Cache-Control': upstreamStatus === 200 ? 'public, max-age=30' : 'no-cache',
      'CDN-Cache-Control': upstreamStatus === 200 ? 'public, max-age=15' : 'no-store',
      'X-Cache': result.rateLimited ? 'RATE-LIMITED' : 'MISS',
    };
    if (upstreamStatus === 429) {
      responseHeaders['Retry-After'] = String(Math.max(1, Math.ceil((openskyGlobal429Until - Date.now()) / 1000)));
    }
    return sendCompressed(req, res, upstreamStatus, {
      ...responseHeaders,
    }, responseData);
  } catch (err) {
    recordRelayOutcome('opensky', classifyOpenSkyOutcome({ error: err }));
    if (settleFlight) settleFlight();
    if (!cacheKey) {
      try {
        const params = new URL(req.url, `http://localhost:${PORT}`).searchParams;
        cacheKey = normalizeOpenSkyBbox(params).cacheKey || ',,,';
      } catch {
        cacheKey = ',,,';
      }
    }
    openskyInFlight.delete(cacheKey);
    safeEnd(res, 500, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: err.message, time: Date.now(), states: null }));
  }
}

async function handleWitsRequest(req, res) {
  const responseHeaders = {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    'CDN-Cache-Control': 'no-store',
  };
  if (req.method !== 'GET') {
    return safeEnd(res, 405, { ...responseHeaders, Allow: 'GET' }, JSON.stringify({ error: 'Method not allowed' }));
  }

  const params = new URL(req.url, 'http://localhost').searchParams;
  const upstreamPath = params.get('path') || '';
  const rows = /^\/API\/V1\/SDMX\/V21\/datasource\/TRN\/reporter\/\d{3}\/partner\/(all|000)\/product\/\d{6}\/year\/(\d{1,4})\/datatype\/(reported|aveestimated)$/.exec(upstreamPath);
  const validRows = rows && Number(rows[2]) >= 1 && Number(rows[2]) <= 2100
    && (rows[3] === 'reported' ? rows[1] === 'all' : rows[1] === '000');
  const validMetadata = /^\/API\/V1\/wits\/datasource\/trn\/(dataavailability\/country\/\d{3}\/year\/all|country\/all)$/.test(upstreamPath);
  if (params.size !== 1 || (!validRows && !validMetadata)) {
    return safeEnd(res, 400, responseHeaders, JSON.stringify({ error: 'Invalid WITS path' }));
  }

  try {
    const upstreamUrl = new URL('https://wits.worldbank.org');
    upstreamUrl.pathname = upstreamPath;
    const upstream = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.1',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(9000),
    });
    const chunks = [];
    let size = 0;
    if (upstream.body) {
      for await (const chunk of upstream.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) throw new Error('WITS response too large');
        chunks.push(chunk);
      }
    }
    return safeEnd(res, upstream.status, {
      ...responseHeaders,
      'Content-Type': upstream.headers.get('content-type') || 'application/xml',
    }, Buffer.concat(chunks));
  } catch (error) {
    const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
    return safeEnd(res, timedOut ? 504 : 502, responseHeaders,
      JSON.stringify({ error: timedOut ? 'WITS request timed out' : 'WITS request failed' }));
  }
}

// ── World Bank proxy (World Bank blocks Vercel edge IPs with 403) ──
const worldbankCache = new Map();

 // key: query string → { data, timestamp }
const WORLDBANK_CACHE_TTL_MS = 30 * 60 * 1000;

 // 30 min — data rarely changes

function handleWorldBankRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const qs = url.search || '';
  const cacheKey = qs;

  const cached = worldbankCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < WORLDBANK_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=1800',
      'CDN-Cache-Control': 'public, max-age=1800',
      'X-Cache': 'HIT',
    }, cached.data);
  }

  const targetUrl = `https://api.worldbank.org/v2${qs.includes('action=indicators') ? '' : '/country'}${url.pathname.replace('/worldbank', '')}${qs}`;
  // Passthrough: forward query params to the Vercel edge handler format
  // The client sends the same params as /api/worldbank, so we re-fetch from upstream
  const wbParams = new URLSearchParams(url.searchParams);
  const action = wbParams.get('action');

  if (action === 'indicators') {
    // Static response — return indicator list directly (same as api/worldbank.js)
    const indicators = {
      'IT.NET.USER.ZS': 'Internet Users (% of population)',
      'IT.CEL.SETS.P2': 'Mobile Subscriptions (per 100 people)',
      'IT.NET.BBND.P2': 'Fixed Broadband Subscriptions (per 100 people)',
      'IT.NET.SECR.P6': 'Secure Internet Servers (per million people)',
      'GB.XPD.RSDV.GD.ZS': 'R&D Expenditure (% of GDP)',
      'IP.PAT.RESD': 'Patent Applications (residents)',
      'IP.PAT.NRES': 'Patent Applications (non-residents)',
      'IP.TMK.RSCT': 'Trademark Applications (resident, by count)',
      'IP.TMK.NRCT': 'Trademark Applications (nonresident, by count)',
      'TX.VAL.TECH.MF.ZS': 'High-Tech Exports (% of manufactured exports)',
      'BX.GSR.CCIS.ZS': 'ICT Service Exports (% of service exports)',
      'TM.VAL.ICTG.ZS.UN': 'ICT Goods Imports (% of total goods imports)',
      'SE.TER.ENRR': 'Tertiary Education Enrollment (%)',
      'SE.XPD.TOTL.GD.ZS': 'Education Expenditure (% of GDP)',
      'NY.GDP.MKTP.KD.ZG': 'GDP Growth (annual %)',
      'NY.GDP.PCAP.CD': 'GDP per Capita (current US$)',
      'NE.EXP.GNFS.ZS': 'Exports of Goods & Services (% of GDP)',
    };
    const defaultCountries = [
      'USA','CHN','JPN','DEU','KOR','GBR','IND','ISR','SGP','TWN',
      'FRA','CAN','SWE','NLD','CHE','FIN','IRL','AUS','BRA','IDN',
      'ARE','SAU','QAT','BHR','EGY','TUR','MYS','THA','VNM','PHL',
      'ESP','ITA','POL','CZE','DNK','NOR','AUT','BEL','PRT','EST',
      'MEX','ARG','CHL','COL','ZAF','NGA','KEN',
    ];
    const body = JSON.stringify({ indicators, defaultCountries });
    worldbankCache.set(cacheKey, { data: body, timestamp: Date.now() });
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=86400',
      'CDN-Cache-Control': 'public, max-age=86400',
      'X-Cache': 'MISS',
    }, body);
  }

  const country = wbParams.get('country');
  const countries = wbParams.get('countries');
  const years = parseInt(wbParams.get('years') || '5', 10);

  const currentYear = new Date().getFullYear();
  const TECH_INDICATORS = {
    'IT.NET.USER.ZS': 'Internet Users (% of population)',
    'IT.CEL.SETS.P2': 'Mobile Subscriptions (per 100 people)',
    'IT.NET.BBND.P2': 'Fixed Broadband Subscriptions (per 100 people)',
    'IT.NET.SECR.P6': 'Secure Internet Servers (per million people)',
    'GB.XPD.RSDV.GD.ZS': 'R&D Expenditure (% of GDP)',
    'IP.PAT.RESD': 'Patent Applications (residents)',
    'IP.PAT.NRES': 'Patent Applications (non-residents)',
    'IP.TMK.RSCT': 'Trademark Applications (resident, by count)',
    'IP.TMK.NRCT': 'Trademark Applications (nonresident, by count)',
    'TX.VAL.TECH.MF.ZS': 'High-Tech Exports (% of manufactured exports)',
    'BX.GSR.CCIS.ZS': 'ICT Service Exports (% of service exports)',
    'TM.VAL.ICTG.ZS.UN': 'ICT Goods Imports (% of total goods imports)',
    'SE.TER.ENRR': 'Tertiary Education Enrollment (%)',
    'SE.XPD.TOTL.GD.ZS': 'Education Expenditure (% of GDP)',
    'NY.GDP.MKTP.KD.ZG': 'GDP Growth (annual %)',
    'NY.GDP.PCAP.CD': 'GDP per Capita (current US$)',
    'NE.EXP.GNFS.ZS': 'Exports of Goods & Services (% of GDP)',
  };

  const indicator = wbParams.get('indicator');
  // Validate World Bank indicator code format (e.g. IT.NET.USER.ZS, NY.GDP.MKTP.CD).
  // Accept any code with 2-6 dot-separated alphanumeric segments; this allows callers
  // to request indicators beyond the TECH_INDICATORS display-name map.
  if (!indicator || !/^[A-Z0-9]{2,10}(\.[A-Z0-9]{2,10}){1,5}$/.test(indicator)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Invalid indicator parameter' }));
  }

  const countryList = normalizeWorldBankCountryCodes(country)
    || normalizeWorldBankCountryCodes(countries)
    || [...WORLD_BANK_COUNTRY_ALLOWLIST].join(';');

  const startYear = currentYear - Math.min(Math.max(1, years), 30);

  const wbUrl = `https://api.worldbank.org/v2/country/${countryList}/indicator/${encodeURIComponent(indicator)}?format=json&date=${startYear}:${currentYear}&per_page=1000`;

  console.log('[Relay] World Bank request (MISS):', indicator);

  const request = https.get(wbUrl, {

    signal: AbortSignal.timeout(15000),
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0; +https://worldmonitor.app)',
    },
    timeout: 15000,
  }, (response) => {
    if (response.statusCode !== 200) {
      safeEnd(res, response.statusCode, { 'Content-Type': 'application/json' }, JSON.stringify({ error: `World Bank API ${response.statusCode}` }));
      return;
    }
    let rawData = '';
    response.on('data', chunk => rawData += chunk);
    response.on('end', () => {
      try {
        const parsed = JSON.parse(rawData);
        // Transform raw World Bank response to match client-expected format
        if (!parsed || !Array.isArray(parsed) || parsed.length < 2 || !parsed[1]) {
          const empty = JSON.stringify({
            indicator,
            indicatorName: TECH_INDICATORS[indicator] || indicator,
            metadata: { page: 1, pages: 1, total: 0 },
            byCountry: {}, latestByCountry: {}, timeSeries: [],
          });
          worldbankCache.set(cacheKey, { data: empty, timestamp: Date.now() });
          return sendCompressed(req, res, 200, {
            'Content-Type': 'application/json',
            'Cache-Control': 'public, max-age=1800',
            'CDN-Cache-Control': 'public, max-age=1800',
            'X-Cache': 'MISS',
          }, empty);
        }

        const [metadata, records] = parsed;
        const transformed = {
          indicator,
          indicatorName: TECH_INDICATORS[indicator] || (records[0]?.indicator?.value || indicator),
          metadata: { page: metadata.page, pages: metadata.pages, total: metadata.total },
          byCountry: {}, latestByCountry: {}, timeSeries: [],
        };

        for (const record of records || []) {
          const cc = record.countryiso3code || record.country?.id;
          const cn = record.country?.value;
          const yr = record.date;
          const val = record.value;
          if (!cc || val === null) continue;
          if (!transformed.byCountry[cc]) transformed.byCountry[cc] = { code: cc, name: cn, values: [] };
          transformed.byCountry[cc].values.push({ year: yr, value: val });
          if (!transformed.latestByCountry[cc] || yr > transformed.latestByCountry[cc].year) {
            transformed.latestByCountry[cc] = { code: cc, name: cn, year: yr, value: val };
          }
          transformed.timeSeries.push({ countryCode: cc, countryName: cn, year: yr, value: val });
        }
        for (const c of Object.values(transformed.byCountry)) c.values.sort((a, b) => a.year - b.year);
        transformed.timeSeries.sort((a, b) => b.year - a.year || a.countryCode.localeCompare(b.countryCode));

        const body = JSON.stringify(transformed);
        worldbankCache.set(cacheKey, { data: body, timestamp: Date.now() });
        sendCompressed(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800',
          'CDN-Cache-Control': 'public, max-age=1800',
          'X-Cache': 'MISS',
        }, body);
      } catch (e) {
        console.error('[Relay] World Bank parse error:', e.message);
        safeEnd(res, 500, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'Parse error' }));
      }
    });
  });
  request.on('error', (err) => {
    console.error('[Relay] World Bank error:', err.message);
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
      }, cached.data);
    }
    safeEnd(res, 502, { 'Content-Type': 'application/json' }, JSON.stringify({ error: err.message }));
  });
  request.on('timeout', () => {
    request.destroy();
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
      }, cached.data);
    }
    safeEnd(res, 504, { 'Content-Type': 'application/json' }, JSON.stringify({ error: 'World Bank request timeout' }));
  });
}

// ── Polymarket proxy (Cloudflare JA3 blocks Vercel edge runtime) ──
const POLYMARKET_ENABLED = String(process.env.POLYMARKET_ENABLED || 'true').toLowerCase() !== 'false';

const polymarketCache = new Map();

 // key: query string → { data, timestamp }
const polymarketInflight = new Map();

 // key → Promise (dedup concurrent requests)
const POLYMARKET_CACHE_TTL_MS = 10 * 60 * 1000;

 // 10 min — reduce upstream pressure
const POLYMARKET_NEG_TTL_MS = 5 * 60 * 1000;

 // 5 min negative cache on 429/error
const POLYMARKET_MAX_BODY_BYTES = 2 * 1024 * 1024;

const POLYMARKET_MAX_CACHE_ENTRIES = 64;

function cachePolymarketResult(key, entry) {
  polymarketCache.delete(key);
  while (polymarketCache.size >= POLYMARKET_MAX_CACHE_ENTRIES) {
    polymarketCache.delete(polymarketCache.keys().next().value);
  }
  polymarketCache.set(key, entry);
}

function backoffPolymarketResult(key) {
  const cached = polymarketCache.get(key);
  const now = Date.now();
  cachePolymarketResult(key, cached?.data
    ? { ...cached, retryAt: now + POLYMARKET_NEG_TTL_MS }
    : { data: null, timestamp: now - POLYMARKET_CACHE_TTL_MS + POLYMARKET_NEG_TTL_MS });
}

// Circuit breaker — stops upstream requests after repeated failures to prevent OOM
const polymarketCircuitBreaker = { failures: 0, openUntil: 0 };

const POLYMARKET_CB_THRESHOLD = 5;

const POLYMARKET_CB_COOLDOWN_MS = 60 * 1000;

// Concurrent upstream limiter — queues excess requests instead of rejecting them
const POLYMARKET_MAX_CONCURRENT = 3;

const POLYMARKET_MAX_QUEUED = 20;

let polymarketActiveUpstream = 0;

const polymarketQueue = [];

 // Array of () => void (resolve-waiters)

function tripPolymarketCircuitBreaker() {
  polymarketCircuitBreaker.failures++;
  if (polymarketCircuitBreaker.failures >= POLYMARKET_CB_THRESHOLD) {
    polymarketCircuitBreaker.openUntil = Date.now() + POLYMARKET_CB_COOLDOWN_MS;
    console.error(`[Relay] Polymarket circuit OPEN — cooling down ${POLYMARKET_CB_COOLDOWN_MS / 1000}s`);
  }
}

function releasePolymarketSlot() {
  polymarketActiveUpstream--;
  if (polymarketQueue.length > 0) {
    const next = polymarketQueue.shift();
    polymarketActiveUpstream++;
    next();
  }
}

function acquirePolymarketSlot() {
  if (polymarketActiveUpstream < POLYMARKET_MAX_CONCURRENT) {
    polymarketActiveUpstream++;
    return Promise.resolve();
  }
  if (polymarketQueue.length >= POLYMARKET_MAX_QUEUED) {
    return Promise.reject(new Error('queue full'));
  }
  return new Promise((resolve) => { polymarketQueue.push(resolve); });
}

function fetchPolymarketUpstream(cacheKey, endpoint, params, tag) {
  return acquirePolymarketSlot().catch(() => 'REJECTED').then((slotResult) => {
    if (slotResult === 'REJECTED') {
      backoffPolymarketResult(cacheKey);
      return null;
    }
    const gammaUrl = `https://gamma-api.polymarket.com/${endpoint}?${params}`;
    console.log('[Relay] Polymarket request (MISS):', endpoint, tag || '');

    return new Promise((resolve) => {
      let finalized = false;
      function finalize(ok) {
        if (finalized) return;
        finalized = true;
        releasePolymarketSlot();
        if (ok) {
          polymarketCircuitBreaker.failures = 0;
        } else {
          tripPolymarketCircuitBreaker();
          backoffPolymarketResult(cacheKey);
        }
      }
      const request = https.get(gammaUrl, {
        signal: AbortSignal.timeout(10000),
        headers: { 'Accept': 'application/json', 'User-Agent': CHROME_UA },
        timeout: 10000,
      }, (response) => {
        if (response.statusCode !== 200) {
          console.error(`[Relay] Polymarket upstream ${response.statusCode} (failures: ${polymarketCircuitBreaker.failures + 1})`);
          response.resume();
          finalize(false);
          resolve(null);
          return;
        }
        let data = '';
        let bytes = 0;
        response.on('data', chunk => {
          if (finalized) return;
          bytes += Buffer.byteLength(chunk);
          if (bytes > POLYMARKET_MAX_BODY_BYTES) {
            finalize(false);
            response.destroy();
            request.destroy();
            resolve(null);
            return;
          }
          data += chunk;
        });
        response.on('end', () => {
          if (finalized) return;
          try {
            if (!Array.isArray(JSON.parse(data))) throw new Error('Expected market list');
          } catch {
            finalize(false);
            resolve(null);
            return;
          }
          finalize(true);
          cachePolymarketResult(cacheKey, { data, timestamp: Date.now() });
          resolve(data);
        });
        response.on('error', () => { finalize(false); resolve(null); });
      });
      request.on('error', (err) => {
        console.error('[Relay] Polymarket error:', err.message);
        finalize(false);
        resolve(null);
      });
      request.on('timeout', () => {
        request.destroy();
        finalize(false);
        resolve(null);
      });
    });
  });
}

function handlePolymarketRequest(req, res) {
  if (!POLYMARKET_ENABLED) {
    return sendCompressed(req, res, 503, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    }, JSON.stringify({ error: 'polymarket disabled', reason: 'POLYMARKET_ENABLED=false' }));
  }
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // Build canonical params FIRST so cache key is deterministic regardless of
  // query-string ordering, tag vs tag_slug alias, or varying limit values.
  // Cache key excludes limit — always fetch upstream with limit=50, slice on serve.
  // This prevents cache fragmentation from different callers (limit=20 vs limit=30).
  const endpoint = url.searchParams.get('endpoint') === 'events' ? 'events' : 'markets';
  const requestedLimit = Math.max(1, Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10) || 50));
  const upstreamLimit = 50; // canonical upstream limit for cache sharing
  const params = new URLSearchParams();
  params.set('closed', url.searchParams.get('closed') === 'true' ? 'true' : 'false');
  const order = url.searchParams.get('order');
  params.set('order', ['volume', 'liquidity', 'startDate', 'endDate', 'spread'].includes(order) ? order : 'volume');
  params.set('ascending', url.searchParams.get('ascending') === 'true' ? 'true' : 'false');
  params.set('limit', String(upstreamLimit));
  const tag = (url.searchParams.get('tag') || url.searchParams.get('tag_slug') || '').replace(/[^a-z0-9-]/gi, '').slice(0, 100);
  if (tag && endpoint === 'events') params.set('tag_slug', tag);

  const cacheKey = endpoint + ':' + params.toString();

  function sliceToLimit(jsonStr) {
    if (requestedLimit >= upstreamLimit) return jsonStr;
    try {
      const arr = JSON.parse(jsonStr);
      if (!Array.isArray(arr)) return jsonStr;
      return JSON.stringify(arr.slice(0, requestedLimit));
    } catch { return jsonStr; }
  }

  const cached = polymarketCache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < POLYMARKET_CACHE_TTL_MS) {
    if (cached.data === null) return safeEnd(res, 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify({ error: 'Polymarket upstream unavailable' }));
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=600',
      'CDN-Cache-Control': 'public, max-age=600',
      'X-Cache': 'HIT',
      'X-Polymarket-Source': 'railway-cache',
    }, sliceToLimit(cached.data));
  }

  const circuitOpen = Date.now() < polymarketCircuitBreaker.openUntil;
  if (circuitOpen || Date.now() < (cached?.retryAt || 0)) {
    if (cached?.data) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
        ...(circuitOpen ? { 'X-Circuit': 'OPEN' } : {}),
        'X-Polymarket-Source': 'railway-stale',
      }, sliceToLimit(cached.data));
    }
    return safeEnd(res, 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Circuit': 'OPEN' }, JSON.stringify({ error: 'Polymarket upstream unavailable' }));
  }

  let inflight = polymarketInflight.get(cacheKey);
  if (!inflight) {
    inflight = fetchPolymarketUpstream(cacheKey, endpoint, params, tag).finally(() => {
      polymarketInflight.delete(cacheKey);
    });
    polymarketInflight.set(cacheKey, inflight);
  }

  // Returned so a throw while serving reaches the router's catch instead of going unhandled.
  return inflight.then((data) => {
    if (data) {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=600',
        'CDN-Cache-Control': 'public, max-age=600',
        'X-Cache': 'MISS',
        'X-Polymarket-Source': 'railway',
      }, sliceToLimit(data));
    } else if (cached?.data) {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': 'STALE',
        'X-Polymarket-Source': 'railway-stale',
      }, sliceToLimit(cached.data));
    } else {
      safeEnd(res, 502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }, JSON.stringify({ error: 'Polymarket upstream unavailable' }));
    }
  });
}

// Periodic cache cleanup to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of openskyResponseCache) {
    if (now - entry.timestamp > OPENSKY_CACHE_TTL_MS * 2) openskyResponseCache.delete(key);
  }
  for (const [key, entry] of openskyNegativeCache) {
    if (now - entry.timestamp > OPENSKY_NEGATIVE_CACHE_TTL_MS * 2) openskyNegativeCache.delete(key);
  }
  for (const [key, entry] of rssResponseCache) {
    const backoffActive = (rssBackoffUntil.get(key) || 0) > now;
    const negativeCacheActive = (rssNegativeCache.get(key)?.timestamp || 0) + RSS_NEGATIVE_CACHE_TTL_MS > now;
    if (now - entry.timestamp > RSS_CACHE_TTL_MS * 2 && !backoffActive && !negativeCacheActive) {
      rssResponseCache.delete(key);
    }
  }
  for (const [key, entry] of rssNegativeCache) {
    if (now - entry.timestamp > RSS_NEGATIVE_CACHE_TTL_MS * 2) rssNegativeCache.delete(key);
  }
  for (const [key, expiry] of rssBackoffUntil) {
    // Only clear backoff timer on expiry — preserve failureCount so
    // the next failure re-escalates immediately instead of resetting to 1min
    if (now > expiry) rssBackoffUntil.delete(key);
  }
  // Clean up failure counts when no backoff is active AND no cache entry exists.
  // Edge case: if cache is evicted (FIFO/age) right when backoff expires, failureCount
  // resets — next failure starts at 1min instead of re-escalating. Window is ~60s, acceptable.
  for (const key of rssFailureCount.keys()) {
    if (!rssBackoffUntil.has(key) && !rssResponseCache.has(key) && !rssNegativeCache.has(key)) {
      rssFailureCount.delete(key);
    }
  }
  for (const [key, entry] of worldbankCache) {
    if (now - entry.timestamp > WORLDBANK_CACHE_TTL_MS * 2) worldbankCache.delete(key);
  }
  for (const [key, entry] of polymarketCache) {
    if (now - entry.timestamp > POLYMARKET_CACHE_TTL_MS * 2 && now >= (entry.retryAt || 0)) polymarketCache.delete(key);
  }
  for (const [key, entry] of yahooChartCache) {
    if (now - entry.ts > YAHOO_CHART_CACHE_TTL_MS * 2) yahooChartCache.delete(key);
  }
  for (const [key, bucket] of requestRateBuckets) {
    if (now >= bucket.resetAt + RELAY_RATE_LIMIT_WINDOW_MS * 2) requestRateBuckets.delete(key);
  }
  for (const [key, ts] of logThrottleState) {
    if (now - ts > RELAY_LOG_THROTTLE_MS * 6) logThrottleState.delete(key);
  }
}, RSS_CACHE_CLEANUP_INTERVAL_MS).unref?.();

// ── Yahoo Finance Chart Proxy ──────────────────────────────────────
const YAHOO_CHART_CACHE_TTL_MS = 300_000;

 // 5 min
const yahooChartCache = new Map();

 // key: symbol:range:interval → { json, gzip, ts }
const YAHOO_SYMBOL_RE = /^[A-Za-z0-9^=\-.]{1,15}$/;

function handleYahooChartRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const symbol = url.searchParams.get('symbol');
  const range = url.searchParams.get('range') || '1d';
  const interval = url.searchParams.get('interval') || '1d';

  if (!symbol || !YAHOO_SYMBOL_RE.test(symbol)) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Invalid or missing symbol parameter' }));
  }

  const cacheKey = `${symbol}:${range}:${interval}`;
  const cached = yahooChartCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < YAHOO_CHART_CACHE_TTL_MS) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=60',
      'X-Yahoo-Source': 'relay-cache',
    }, cached.json);
  }

  const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${encodeURIComponent(range)}&interval=${encodeURIComponent(interval)}`;

  function _serveYahooResult(body, source) {
    yahooChartCache.set(cacheKey, { json: body, ts: Date.now() });
    sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=120, s-maxage=120, stale-while-revalidate=60',
      'X-Yahoo-Source': source,
    }, body);
  }

  function _serveStaleOrError(statusCode, errMsg) {
    if (cached) {
      return sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'X-Yahoo-Source': 'relay-stale',
      }, cached.json);
    }
    sendCompressed(req, res, statusCode, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: errMsg, symbol }));
  }

  let _proxied = false;
  function _tryProxy() {
    if (_proxied) return;
    _proxied = true;
    if (!PROXY_URL) return _serveStaleOrError(502, 'Yahoo upstream failed, no proxy');
    const proxy = { ...parseProxyUrl(PROXY_URL), tls: true };
    fetchViaProxy(yahooUrl, proxy).then((proxyResp) => {
      if (!proxyResp?.ok) return _serveStaleOrError(proxyResp?.status || 502, 'Yahoo proxy failed');
      _serveYahooResult(proxyResp.body, 'relay-proxy');
    }).catch(() => _serveStaleOrError(502, 'Yahoo proxy error'));
  }

  const yahooReq = https.get(yahooUrl, {

    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    timeout: 10000,
  }, (upstream) => {
    let body = '';
    upstream.on('data', (chunk) => { body += chunk; });
    upstream.on('end', () => {
      if (upstream.statusCode !== 200) {
        logThrottled('warn', `yahoo-chart-upstream-${upstream.statusCode}:${symbol}`,
          `[Relay] Yahoo chart upstream ${upstream.statusCode} for ${symbol}`);
        return _tryProxy();
      }
      _serveYahooResult(body, 'relay-upstream');
    });
  });
  yahooReq.on('error', (err) => {
    logThrottled('error', `yahoo-chart-error:${symbol}`, `[Relay] Yahoo chart error for ${symbol}: ${err.message}`);
    _tryProxy();
  });
  yahooReq.on('timeout', () => {
    yahooReq.destroy();
    _tryProxy();
  });
}

// ── Crypto Quotes Gap Proxy ────────────────────────────────────────────
// Resolves CoinGecko IDs on demand from the Railway egress IP (per-ID
// CoinGecko -> CoinPaprika) for the edge handler's bounded gap path (#6306).
// The edge handler serves seed hits from Redis and only sends cache-miss gap
// ids here; this route performs the provider work and never writes Redis.
const CRYPTO_QUOTES_MAX_IDS = 25;

function handleCryptoQuotesRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const idsParam = url.searchParams.get('ids') || '';
  const ids = [...new Set(idsParam.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (ids.length === 0) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Missing ids parameter' }));
  }
  if (ids.length > CRYPTO_QUOTES_MAX_IDS) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: `At most ${CRYPTO_QUOTES_MAX_IDS} ids per request` }));
  }
  const reverseMap = new Map(Object.entries(CRYPTO_PAPRIKA_MAP).map(([g, p]) => [p, g]));
  const byGeckoId = new Map();
  (async () => {
    // CoinGecko first (matches edge fetchGapQuotes), then paprika for still-missing.
    try {
      const { base, headers } = coingeckoEndpoint();
      const geckoUrl = `${base}/coins/markets?vs_currency=usd&ids=${encodeURIComponent(ids.join(','))}&order=market_cap_desc&sparkline=true&price_change_percentage=24h`;
      const gecko = await cyberHttpGetJson(geckoUrl, headers, 15000);
      if (Array.isArray(gecko)) {
        for (const c of gecko) {
          if (!c?.id) continue;
          byGeckoId.set(c.id, {
            id: c.id,
            name: c.name,
            symbol: (c.symbol || '').toLowerCase(),
            quotes: { USD: { price: c.current_price || 0, percent_change_24h: c.price_change_percentage_24h || 0, percent_change_7d: c.price_change_percentage_7d_in_currency || 0 } },
            sparkline_in_7d: c.sparkline_in_7d,
          });
        }
      }
    } catch (err) {
      console.warn(`[Relay][CryptoQuotes] CoinGecko failed: ${err.message}`);
    }

    const stillMissing = ids.filter((id) => !byGeckoId.has(id));
    if (stillMissing.length > 0) {
      const paprikaIds = stillMissing.map((id) => CRYPTO_PAPRIKA_MAP[id]).filter(Boolean);
      if (paprikaIds.length > 0) {
        try {
          const data = await _fetchCoinPaprikaTickersById(paprikaIds);
          if (Array.isArray(data)) {
            for (const row of data) {
              const geckoId = reverseMap.get(row.id) || stillMissing.find((id) => CRYPTO_PAPRIKA_MAP[id] === row.id);
              if (!geckoId || byGeckoId.has(geckoId)) continue;
              byGeckoId.set(geckoId, row);
            }
          }
        } catch (err) {
          console.warn(`[Relay][CryptoQuotes] CoinPaprika failed: ${err.message}`);
        }
      }
    }

    if (byGeckoId.size === 0) {
      return sendCompressed(req, res, 502, { 'Content-Type': 'application/json' },
        JSON.stringify({ error: 'All crypto providers failed' }));
    }

    const quotes = [];
    const unresolved = [];
    for (const id of ids) {
      const row = byGeckoId.get(id);
      if (!row) { unresolved.push(id); continue; }
      const prices = row.sparkline_in_7d?.price;
      quotes.push({
        id,
        name: row.name || id,
        symbol: (row.symbol || id).toUpperCase(),
        price: row.quotes?.USD?.price || 0,
        change: row.quotes?.USD?.percent_change_24h || 0,
        change7d: row.quotes?.USD?.percent_change_7d || 0,
        sparkline: prices && prices.length > 24 ? prices.slice(-48) : (prices || []),
      });
    }
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=60, s-maxage=60, stale-while-revalidate=30',
      'X-Crypto-Source': 'relay',
    }, JSON.stringify({ quotes, unresolved }));
  })().catch((err) => {
    console.warn(`[Relay][CryptoQuotes] error: ${err.message}`);
    return sendCompressed(req, res, 502, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Crypto quotes proxy error' }));
  });
}

// ── Proxy fetch helper ─────────────────────────────────────────────
// Resolves { ok, status, body } and never rejects. Written for the retired YouTube live
// detection; the relay's PROXY_URL callers (Yahoo chart, USNI and others) still use it.
function fetchViaProxy(targetUrl, proxy) {
  const { proxyFetch } = require('./_proxy-utils.cjs');
  return proxyFetch(targetUrl, proxy, { headers: { 'User-Agent': CHROME_UA } })
    .then(r => ({ ok: r.ok, status: r.status, body: r.buffer.toString('utf8') }))
    .catch(() => ({ ok: false, status: 0, body: '' }));
}

// ─────────────────────────────────────────────────────────────
// NOTAM proxy — ICAO API times out from Vercel edge, relay proxies
// ─────────────────────────────────────────────────────────────
const ICAO_API_KEY = process.env.ICAO_API_KEY;

const notamCache = { data: null, ts: 0 };

const NOTAM_CACHE_TTL = 30 * 60 * 1000;

 // 30 min
// Comma-separated ICAO location indicators. The value is pasted into the ICAO
// query string after the API key, so nothing else may get through.
const NOTAM_LOCATIONS_RE = /^[A-Z0-9]{4}(?:,[A-Z0-9]{4}){0,199}$/;

function handleNotamProxyRequest(req, res) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const locations = url.searchParams.get('locations');
  if (!locations) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Missing locations parameter' }));
  }
  if (!NOTAM_LOCATIONS_RE.test(locations)) {
    return sendCompressed(req, res, 400, { 'Content-Type': 'application/json' },
      JSON.stringify({ error: 'Invalid locations parameter' }));
  }
  if (!ICAO_API_KEY) {
    return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
      JSON.stringify([]));
  }

  const cacheKey = locations.split(',').sort().join(',');
  if (notamCache.data && notamCache.key === cacheKey && Date.now() - notamCache.ts < NOTAM_CACHE_TTL) {
    return sendCompressed(req, res, 200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=1800, s-maxage=1800',
      'X-Cache': 'HIT',
    }, notamCache.data);
  }

  const apiUrl = `https://dataservices.icao.int/api/notams-realtime-list?api_key=${ICAO_API_KEY}&format=json&locations=${locations}`;

  const request = https.get(apiUrl, {

    signal: AbortSignal.timeout(25000),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36' },
    timeout: 25000,
  }, (upstream) => {
    if (upstream.statusCode !== 200) {
      console.warn(`[Relay] NOTAM upstream HTTP ${upstream.statusCode}`);
      upstream.resume();
      return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
    const ct = upstream.headers['content-type'] || '';
    if (ct.includes('text/html')) {
      console.warn('[Relay] NOTAM upstream returned HTML (challenge page)');
      upstream.resume();
      return sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
    const chunks = [];
    upstream.on('data', c => chunks.push(c));
    upstream.on('end', () => {
      const body = Buffer.concat(chunks).toString();
      try {
        JSON.parse(body); // validate JSON
        notamCache.data = body;
        notamCache.key = cacheKey;
        notamCache.ts = Date.now();
        console.log(`[Relay] NOTAM: ${body.length} bytes for ${locations}`);
        sendCompressed(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=1800, s-maxage=1800',
          'X-Cache': 'MISS',
        }, body);
      } catch {
        console.warn('[Relay] NOTAM: invalid JSON response');
        sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
          JSON.stringify([]));
      }
    });
  });

  request.on('error', (err) => {
    console.warn(`[Relay] NOTAM error: ${err.message}`);
    if (!res.headersSent) {
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
  });

  request.on('timeout', () => {
    request.destroy();
    console.warn('[Relay] NOTAM timeout (25s)');
    if (!res.headersSent) {
      sendCompressed(req, res, 200, { 'Content-Type': 'application/json' },
        JSON.stringify([]));
    }
  });
}

// A throw that escapes a request (the router's own awaits, or an async route
// handler) would otherwise be an unhandled rejection, which exits the relay on
// Node 24 and takes every route and the AIS stream down with it. Route handlers
// are dispatched with `return` so this one catch covers them.
function handleRelayRequestFailure(res, err) {
  console.error('[Relay] request handler failed:', err?.name || 'Error', err?.message || '');
  // A half-written body must not be ended as if complete: cut the socket so the client sees the failure.
  if (res.headersSent) {
    if (!res.writableEnded) res.destroy();
    return;
  }
  safeEnd(res, 500, {}, '');
}

async function handleProviderRequest(req, res) {
  const pathname = (req.url || '/').split('?')[0];
  if (pathname.startsWith('/oref/') && (!orefState.lastPollAt || orefState.lastError)) {
    return safeEnd(res, 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      JSON.stringify({ configured: true, alerts: [], historyCount24h: orefState.historyCount24h,
        error: orefState.lastError || 'Siren collection has not completed yet' }));
  }
  if (pathname.startsWith('/ais/snapshot')) {
    incrementRelayMetric('aisSnapshotRequests');
    // Aggregated AIS snapshot for server-side fanout — serve pre-serialized + pre-gzipped
    connectUpstream();
    recordAisSnapshotAvailability(buildSnapshot()); // ensures cache is warm and records usable freshness
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const includeCandidates = url.searchParams.get('candidates') === 'true';
    const includeTankers = url.searchParams.get('tankers') === 'true';
    const bbox = parseBbox(url.searchParams.get('bbox'));

    // Fast path: pre-gzipped cache covers the {with|without}-candidates
    // case only (no tankers, no bbox). Used by the existing AIS density +
    // military-detection consumers, which are the vast majority of traffic.
    if (!includeTankers && !bbox) {
      const json = includeCandidates ? lastSnapshotWithCandJson : lastSnapshotJson;
      const gz = includeCandidates ? lastSnapshotWithCandGzip : lastSnapshotGzip;
      const br = includeCandidates ? lastSnapshotWithCandBrotli : lastSnapshotBrotli;
      if (json) {
        sendPreGzipped(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=2',
          'CDN-Cache-Control': 'public, max-age=10',
        }, json, gz, br);
      } else {
        const payload = { ...lastSnapshot, candidateReports: includeCandidates ? getCandidateReportsSnapshot() : [], tankerReports: [] };
        sendCompressed(req, res, 200, {
          'Content-Type': 'application/json',
          'Cache-Control': 'public, max-age=2',
          'CDN-Cache-Control': 'public, max-age=10',
        }, JSON.stringify(payload));
      }
    } else {
      // Live-tanker path: bbox-filtered + tanker-included responses skip the
      // pre-gzipped cache (bbox space would explode the cache key set).
      // Handler-side 60s cache (server/worldmonitor/maritime/v1/get-vessel-snapshot.ts)
      // and the gateway 'live' tier absorb identical-bbox requests.
      const payload = {
        ...lastSnapshot,
        candidateReports: includeCandidates ? getCandidateReportsSnapshot() : [],
        tankerReports: includeTankers ? getTankerReportsSnapshot(bbox) : [],
      };
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=2',
        'CDN-Cache-Control': 'public, max-age=10',
      }, JSON.stringify(payload));
    }
  } else if (pathname.startsWith('/rss')) {
    // Proxy RSS feeds that block Vercel IPs
    let feedUrl = '';
    try {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      feedUrl = url.searchParams.get('url') || '';

      if (!feedUrl) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Missing url parameter' }));
      }
      incrementRelayMetric('rssRequests');

      // Domain allowlist from shared source of truth (shared/rss-allowed-domains.js)
      const parsed = new URL(feedUrl);
      // Block deprecated/stale feed domains — stale clients still request these
      const blockedDomains = ['rsshub.app'];
      if (blockedDomains.includes(parsed.hostname)) {
        recordRelayOutcome('rss', 'terminalFailure');
        res.writeHead(410, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Feed deprecated' }));
      }
      // The allowlist names hosts, not services: only their default ports.
      if (!RSS_ALLOWED_DOMAINS.has(parsed.hostname) || parsed.port !== '') {
        recordRelayOutcome('rss', 'terminalFailure');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Domain not allowed on Railway proxy' }));
      }
      if (!RSS_ALLOWED_PROTOCOLS.has(parsed.protocol)) {
        recordRelayOutcome('rss', 'terminalFailure');
        res.writeHead(403, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'Protocol not allowed on Railway proxy' }));
      }

      const sendRssStale = (cacheEntry, cacheLabel = 'STALE', extraHeaders = {}) => sendCompressed(req, res, 200, {
        'Content-Type': cacheEntry.contentType || 'application/xml',
        'Cache-Control': 'no-store',
        'CDN-Cache-Control': 'no-store',
        'X-Cache': cacheLabel,
        ...extraHeaders,
        'X-Relay-Stale': '1',
      }, cacheEntry.data);

      // Backoff guard: if feed is in exponential backoff, don't hit upstream
      const backoffExpiry = rssBackoffUntil.get(feedUrl);
      const backoffNow = Date.now();
      if (backoffExpiry && backoffNow < backoffExpiry) {
        const rssCachedForBackoff = rssResponseCache.get(feedUrl);
        if (rssCachedForBackoff) {
          recordRelayOutcome('rss', 'throttle');
          recordRelayOutcome('rss', 'fallback');
          incrementRelayMetric('rssServed');
          return sendRssStale(rssCachedForBackoff, 'BACKOFF-STALE');
        }
        const remainSec = Math.max(1, Math.round((backoffExpiry - backoffNow) / 1000));
        recordRelayOutcome('rss', 'throttle');
        res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': String(remainSec) });
        return res.end(JSON.stringify({ error: 'Feed in backoff', retryAfterSec: remainSec }));
      }

      // Two-layer negative caching:
      // 1. Backoff guard above: exponential (1→15min) for network errors (socket hang up, timeout)
      // 2. The negative cache below: flat 1min TTL for non-2xx upstream responses (429, 503, etc.)
      // Keep negative responses separate from the positive cache so an upstream
      // rejection cannot erase the last body that can be served stale.
      const rssCached = rssResponseCache.get(feedUrl);
      const rssNegativeCached = rssNegativeCache.get(feedUrl);
      if (rssCached && Date.now() - rssCached.timestamp < RSS_CACHE_TTL_MS) {
        incrementRelayMetric('rssServed');
        return sendCompressed(req, res, 200, {
          'Content-Type': rssCached.contentType || 'application/xml',
          'Cache-Control': 'public, max-age=300',
          'CDN-Cache-Control': 'public, max-age=600, stale-while-revalidate=300',
          'X-Cache': 'HIT',
        }, rssCached.data);
      }
      if (rssNegativeCached) {
        if (Date.now() - rssNegativeCached.timestamp < RSS_NEGATIVE_CACHE_TTL_MS) {
          recordRelayOutcome('rss', classifyUpstreamOutcome({ status: rssNegativeCached.statusCode }));
          if (rssCached) {
            recordRelayOutcome('rss', 'fallback');
            incrementRelayMetric('rssServed');
            return sendRssStale(rssCached, 'NEGATIVE-STALE');
          }
          return sendCompressed(req, res, rssNegativeCached.statusCode || 502, {
            'Content-Type': rssNegativeCached.contentType || 'application/xml',
            'Cache-Control': 'no-cache',
            'CDN-Cache-Control': 'no-store',
            'X-Cache': 'HIT',
          }, rssNegativeCached.data);
        }
        rssNegativeCache.delete(feedUrl);
      }

      // In-flight dedup: if another request for the same feed is already fetching,
      // wait for it and serve from cache instead of hammering upstream.
      const existing = rssInFlight.get(feedUrl);
      if (existing) {
        try {
          const fetchResult = await existing;
          const deduped = rssResponseCache.get(feedUrl);
          if (deduped) {
            const dedupedNegative = rssNegativeCache.get(feedUrl);
            incrementRelayMetric('rssServed');
            if (dedupedNegative || fetchResult?.stale) {
              recordRelayOutcome('rss', dedupedNegative
                ? classifyUpstreamOutcome({ status: dedupedNegative.statusCode })
                : fetchResult.outcome);
              recordRelayOutcome('rss', 'fallback');
              return sendRssStale(deduped, 'DEDUP-STALE');
            }
            return sendCompressed(req, res, 200, {
              'Content-Type': deduped.contentType || 'application/xml',
              'Cache-Control': 'public, max-age=300',
              'CDN-Cache-Control': 'public, max-age=600, stale-while-revalidate=300',
              'X-Cache': 'DEDUP',
            }, deduped.data);
          }
          const dedupedNegative = rssNegativeCache.get(feedUrl);
          if (dedupedNegative) {
            recordRelayOutcome('rss', classifyUpstreamOutcome({ status: dedupedNegative.statusCode }));
            return sendCompressed(req, res, dedupedNegative.statusCode || 502, {
              'Content-Type': dedupedNegative.contentType || 'application/xml',
              'Cache-Control': 'no-cache',
              'CDN-Cache-Control': 'no-store',
              'X-Cache': 'DEDUP',
            }, dedupedNegative.data);
          }
          // In-flight completed but nothing cached — serve 502 instead of cascading
          recordRelayOutcome('rss', 'terminalFailure');
          return safeEnd(res, 502, { 'Content-Type': 'application/json' },
            JSON.stringify({ error: 'Upstream fetch completed but not cached' }));
        } catch {
          // In-flight fetch failed — serve 502 instead of starting another fetch
          recordRelayOutcome('rss', 'terminalFailure');
          return safeEnd(res, 502, { 'Content-Type': 'application/json' },
            JSON.stringify({ error: 'Upstream fetch failed' }));
        }
      }

      logThrottled('log', `rss-miss:${feedUrl}`, '[Relay] RSS request (MISS):', feedUrl);

      const fetchPromise = new Promise((resolveInFlight, rejectInFlight) => {
      let responseHandled = false;
      let outcomeRecorded = false;
      let failureRecorded = false;

      const recordAttemptOutcome = (status, error) => {
        if (outcomeRecorded) return;
        outcomeRecorded = true;
        const outcome = classifyUpstreamOutcome({ status, error });
        recordRelayOutcome('rss', outcome);
        return outcome;
      };

      const recordFailure = () => {
        if (failureRecorded) {
          const failures = rssFailureCount.get(feedUrl) || 1;
          const remaining = Math.max(1, Math.round(((rssBackoffUntil.get(feedUrl) || Date.now()) - Date.now()) / 1000));
          return { failures, backoffSec: remaining };
        }
        failureRecorded = true;
        return rssRecordFailure(feedUrl);
      };

      const sendError = (statusCode, message) => {
        if (responseHandled || res.headersSent) return;
        responseHandled = true;
        recordAttemptOutcome(statusCode, new Error(message));
        const { backoffSec } = recordFailure();
        res.writeHead(statusCode, {
          'Content-Type': 'application/json',
          'Retry-After': String(backoffSec),
        });
        res.end(JSON.stringify({ error: message }));
        rejectInFlight(new Error(message));
      };

      // A blocked DNS answer is a verdict on the feed, not an upstream outage.
      // No backoff (backoff would serve the stale body with a 200), the last
      // good body is evicted so nothing can be served from it, and a 403
      // negative entry answers in-flight followers and the next minute of
      // callers without another lookup.
      const sendBlocked = (message) => {
        if (responseHandled || res.headersSent) return;
        responseHandled = true;
        recordAttemptOutcome(403, new Error(message));
        rssResponseCache.delete(feedUrl);
        rssResetFailure(feedUrl);
        const data = Buffer.from(JSON.stringify({ error: message }));
        setBoundedCacheEntry(rssNegativeCache, feedUrl, {
          data, contentType: 'application/json', statusCode: 403, timestamp: Date.now(),
        }, RSS_NEGATIVE_CACHE_MAX_ENTRIES);
        res.writeHead(403, {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-store',
          'CDN-Cache-Control': 'no-store',
        });
        res.end(data);
        resolveInFlight({ outcome: 'terminalFailure' });
      };

      const fetchWithRedirects = (url, redirectCount = 0) => {
        if (redirectCount > 3) {
          return sendError(502, 'Too many redirects');
        }

        const conditionalHeaders = {};
        if (rssCached?.etag) conditionalHeaders['If-None-Match'] = rssCached.etag;
        if (rssCached?.lastModified) conditionalHeaders['If-Modified-Since'] = rssCached.lastModified;

        const protocol = url.startsWith('https') ? https : http;
        const request = protocol.get(url, {
          headers: {
            'Accept': 'application/rss+xml, application/xml, text/xml, */*',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept-Language': 'en-US,en;q=0.9',
            // Smartraveller's Akamai edge never answers a request without
            // Accept-Encoding (the relay logged `read ETIMEDOUT` on every miss).
            // gzip only: the body handler below decodes gzip and deflate, and
            // gzip is the one every server that compresses supports.
            'Accept-Encoding': 'gzip',
            ...conditionalHeaders,
          },
          timeout: 15000,
          // Bumped from Node's 16KB default. Some publishers (Substack, big-CDN-
          // fronted feeds) chain Set-Cookie + CSP + Permissions-Policy + tracking
          // headers that exceed 16KB, which makes Node's HTTP parser throw
          // `Parse Error: Header overflow` and fail every fetch from this relay.
          // The relay's in-memory rssResponseCache used to mask this on long-
          // running deploys; a redeploy clears the cache and the broken feeds
          // surface immediately. 64KB is well above any legitimate header set,
          // and is per-request (no process-level Node flag needed).
          maxHeaderSize: 65536,
          lookup: rssGuardedLookup,
        }, (response) => {
          if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
            // A malformed Location from an allowlisted upstream must be a 502
            // for this feed, not an uncaught TypeError that exits the relay.
            let redirectTarget;
            try {
              redirectTarget = new URL(response.headers.location, url);
            } catch {
              return sendError(502, 'Malformed redirect');
            }
            const redirectUrl = redirectTarget.href;
            if (!RSS_ALLOWED_DOMAINS.has(redirectTarget.hostname) || !RSS_ALLOWED_PROTOCOLS.has(redirectTarget.protocol) || redirectTarget.port !== '') {
              return sendError(403, 'Redirect to disallowed domain');
            }
            logThrottled('log', `rss-redirect:${feedUrl}:${redirectUrl}`, `[Relay] Following redirect to: ${redirectUrl}`);
            return fetchWithRedirects(redirectUrl, redirectCount + 1);
          }

          if (response.statusCode === 304 && rssCached) {
            responseHandled = true;
            const outcome = recordAttemptOutcome(200);
            incrementRelayMetric('rssServed');
            rssCached.timestamp = Date.now();
            rssResetFailure(feedUrl);
            resolveInFlight({ outcome });
            logThrottled('log', `rss-revalidated:${feedUrl}`, '[Relay] RSS 304 revalidated:', feedUrl);
            sendCompressed(req, res, 200, {
              'Content-Type': rssCached.contentType || 'application/xml',
              'Cache-Control': 'public, max-age=300',
              'CDN-Cache-Control': 'public, max-age=600, stale-while-revalidate=300',
              'X-Cache': 'REVALIDATED',
            }, rssCached.data);
            return;
          }

          const encoding = response.headers['content-encoding'];
          let stream = response;
          if (encoding === 'gzip' || encoding === 'deflate') {
            stream = encoding === 'gzip' ? response.pipe(zlib.createGunzip()) : response.pipe(zlib.createInflate());
          }

          const chunks = [];
          let bodyBytes = 0;
          stream.on('data', (chunk) => {
            bodyBytes += chunk.length;
            if (bodyBytes > RSS_MAX_BODY_BYTES) {
              sendError(502, 'Feed too large');
              if (stream !== response) stream.destroy();
              request.destroy();
            }
            chunks.push(chunk);
          });
          // Aborting mid-body surfaces as an error on the response as well as
          // on the decompression stream; both are already answered above.
          response.on('error', () => {});
          stream.on('end', () => {
            if (responseHandled || res.headersSent) return;
            responseHandled = true;
            const data = Buffer.concat(chunks);
            const isSuccess = response.statusCode >= 200 && response.statusCode < 300;
            const cacheEntry = {
              data, contentType: 'application/xml', statusCode: response.statusCode, timestamp: Date.now(),
            };
            if (isSuccess) {
              cacheEntry.etag = response.headers.etag || null;
              cacheEntry.lastModified = response.headers['last-modified'] || null;
              setBoundedCacheEntry(rssResponseCache, feedUrl, cacheEntry, RSS_CACHE_MAX_ENTRIES);
              rssNegativeCache.delete(feedUrl);
            } else {
              setBoundedCacheEntry(rssNegativeCache, feedUrl, cacheEntry, RSS_NEGATIVE_CACHE_MAX_ENTRIES);
            }
            const responseHeaders = {
              'Content-Type': 'application/xml',
              'Cache-Control': isSuccess ? 'public, max-age=300' : 'no-cache',
              'CDN-Cache-Control': isSuccess ? 'public, max-age=600, stale-while-revalidate=300' : 'no-store',
              'X-Cache': 'MISS',
            };
            let outcome;
            if (isSuccess) {
              outcome = recordAttemptOutcome(response.statusCode);
              incrementRelayMetric('rssServed');
              rssResetFailure(feedUrl);
            } else {
              outcome = recordAttemptOutcome(response.statusCode);
              const { failures, backoffSec } = recordFailure();
              logThrottled('warn', `rss-upstream:${feedUrl}:${response.statusCode}`, `[Relay] RSS upstream ${response.statusCode} for ${feedUrl} (backoff ${backoffSec}s, failures=${failures})`);
              responseHeaders['Retry-After'] = String(backoffSec);
              if (rssCached) {
                incrementRelayMetric('rssServed');
                recordRelayOutcome('rss', 'fallback');
                resolveInFlight({ stale: true, outcome });
                sendRssStale(rssCached, 'STALE', { 'Retry-After': String(backoffSec) });
                return;
              }
            }
            resolveInFlight({ outcome });
            sendCompressed(req, res, response.statusCode, responseHeaders, data);
          });
          stream.on('error', (err) => {
            recordAttemptOutcome(502, err);
            const { failures, backoffSec } = recordFailure();
            logThrottled('error', `rss-decompress:${feedUrl}:${err.code || err.message}`, `[Relay] Decompression error: ${err.message} (backoff ${backoffSec}s, failures=${failures})`);
            sendError(502, 'Decompression failed: ' + err.message);
          });
        });

        request.on('error', (err) => {
          if (err.code === SSRF_BLOCKED_ERROR_CODE) {
            logThrottled('warn', `rss-ssrf-blocked:${feedUrl}`, `[Relay] RSS blocked: ${err.message}`);
            return sendBlocked('Feed resolves to a blocked address');
          }
          const outcome = recordAttemptOutcome(0, err);
          const { failures, backoffSec } = recordFailure();
          logThrottled('error', `rss-error:${feedUrl}:${err.code || err.message}`, `[Relay] RSS error: ${err.message} (backoff ${backoffSec}s, failures=${failures})`);
          // Serve stale on error (only if we have previous successful data)
          if (rssCached) {
            if (!responseHandled && !res.headersSent) {
              responseHandled = true;
              incrementRelayMetric('rssServed');
              recordRelayOutcome('rss', 'fallback');
              sendRssStale(rssCached);
            }
            resolveInFlight({ stale: true, outcome });
            return;
          }
          sendError(502, err.message);
        });

        request.on('timeout', () => {
          request.destroy();
          const outcome = recordAttemptOutcome(504, new Error('timeout'));
          const { failures, backoffSec } = recordFailure();
          logThrottled('warn', `rss-timeout:${feedUrl}`, `[Relay] RSS timeout for ${feedUrl} (backoff ${backoffSec}s, failures=${failures})`);
          if (rssCached && !responseHandled && !res.headersSent) {
            responseHandled = true;
            incrementRelayMetric('rssServed');
            recordRelayOutcome('rss', 'fallback');
            sendRssStale(rssCached);
            resolveInFlight({ stale: true, outcome });
            return;
          }
          sendError(504, 'Request timeout');
        });
      };

      fetchWithRedirects(feedUrl);
      }); // end fetchPromise

      rssInFlight.set(feedUrl, fetchPromise);
      fetchPromise.catch(() => {}).finally(() => rssInFlight.delete(feedUrl));
    } catch (err) {
      if (feedUrl) rssInFlight.delete(feedUrl);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    }
  } else if (pathname === '/oref/alerts') {
    const c = orefState._alertsCache;
    if (c) {
      sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=5, s-maxage=5, stale-while-revalidate=3',
      }, c.json, c.gzip, c.brotli);
    } else {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=5, s-maxage=5, stale-while-revalidate=3',
      }, JSON.stringify({
        configured: SIREN_ALERTS_ENABLED,
        alerts: orefState.lastAlerts || [],
        historyCount24h: orefState.historyCount24h,
        totalHistoryCount: orefState.totalHistoryCount,
        timestamp: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : new Date().toISOString(),
        ...(orefState.lastError ? { error: orefState.lastError } : {}),
      }));
    }
  } else if (pathname === '/oref/history') {
    const c = orefState._historyCache;
    if (c) {
      sendPreGzipped(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=10',
      }, c.json, c.gzip, c.brotli);
    } else {
      sendCompressed(req, res, 200, {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=30, s-maxage=30, stale-while-revalidate=10',
      }, JSON.stringify({
        configured: SIREN_ALERTS_ENABLED,
        history: orefState.history || [],
        historyCount24h: orefState.historyCount24h,
        totalHistoryCount: orefState.totalHistoryCount,
        timestamp: orefState.lastPollAt ? new Date(orefState.lastPollAt).toISOString() : new Date().toISOString(),
      }));
    }
  } else if (pathname.startsWith('/ucdp-events')) {
    return handleUcdpEventsRequest(req, res);
  } else if (pathname.startsWith('/wingbits/track')) {
    return handleWingbitsTrackRequest(req, res);
  } else if (pathname.startsWith('/opensky')) {
    return handleOpenSkyRequest(req, res, PORT);
  } else if (pathname.startsWith('/worldbank')) {
    return handleWorldBankRequest(req, res);
  } else if (pathname === '/wits') {
    return handleWitsRequest(req, res);
  } else if (pathname.startsWith('/polymarket')) {
    return handlePolymarketRequest(req, res);
  } else if (pathname === '/yahoo-chart') {
    return handleYahooChartRequest(req, res);
  } else if (pathname === '/crypto-quotes') {
    return handleCryptoQuotesRequest(req, res);
  } else if (pathname === '/notam') {
    return handleNotamProxyRequest(req, res);
  } else if (pathname === '/google-flights/search') {
    return handleGoogleFlightsSearch(req, res);
  } else if (pathname === '/google-flights/search-dates') {
    return handleGoogleFlightsDates(req, res);
  } else {
    res.writeHead(404);
    res.end();
  }
}

// ─── Google Flights ───────────────────────────────────────────────────────────
//
// The FlightsFrontendService RPCs (GetShoppingResults, GetCalendarGraph) now
// require a per-request BotGuard token and answer RPC status 13 without one.
// The server-rendered results page still embeds the shopping payload those
// RPCs returned, as its `ds:1` AF_initDataCallback block, so both routes read
// that page. Filters travel in the page's `tfs` parameter.

const GF_PAGE_URL = 'https://www.google.com/travel/flights/search';

const GF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
  // Pre-accepted consent: without it an EU-routed request gets the consent page.
  'Cookie': 'CONSENT=YES+',
};

let gfGlobal429Until = 0;

const GF_429_COOLDOWN_MS = Number(process.env.GF_429_COOLDOWN_MS) || 120 * 1000;

const GF_PAGE_TIMEOUT_MS = 12_000;

// One results page per day. 31 days at six pages in flight measured ~7s from
// the relay; the deadline keeps a slow provider inside the edge's 30s wait.
const GF_DATES_MAX_DAYS = 31;

const GF_DATES_CONCURRENCY = 6;

const GF_DATES_DEADLINE_MS = 20_000;

// Pages in flight across every search, so concurrent date searches cannot
// burst Google into a 429 that cools the route down for all callers.
const GF_PAGE_SLOTS = 8;

let gfPagesInFlight = 0;

const gfPageWaiters = [];

async function withGfPageSlot(signal, run) {
  while (gfPagesInFlight >= GF_PAGE_SLOTS) {
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const onAbort = () => {
        gfPageWaiters.splice(gfPageWaiters.indexOf(wake), 1);
        reject(signal.reason);
      };
      const wake = () => { signal.removeEventListener('abort', onAbort); resolve(); };
      gfPageWaiters.push(wake);
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
  gfPagesInFlight++;
  try {
    return await run();
  } finally {
    gfPagesInFlight--;
    gfPageWaiters.shift()?.();
  }
}

function gfCabinClass(cabin) {
  switch ((cabin || '').toUpperCase()) {
    case 'PREMIUM_ECONOMY': return 2;
    case 'BUSINESS': return 3;
    case 'FIRST': return 4;
    default: return 1;
  }
}

// `tfs` takes the stop count itself; null leaves stops unfiltered.
function gfMaxStops(stops) {
  switch ((stops || '').toUpperCase()) {
    case 'NON_STOP': case '0': return 0;
    case 'ONE_STOP': case '1': return 1;
    case 'TWO_PLUS_STOPS': case '2': return 2;
    default: return null;
  }
}

// Parse a query-param airlines value that may be a comma-joined string (from
// codegen serialization) or an array (from getAll). Returns a clean string[].
function gfParseAirlines(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : String(raw).split(',');
  return arr.map(s => s.trim().toUpperCase()).filter(Boolean);
}

function gfVarint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n >>>= 7; }
  out.push(n);
  return out;
}

const gfInt = (field, n) => [...gfVarint(field << 3), ...gfVarint(n)];

const gfBytes = (field, bytes) => [...gfVarint((field << 3) | 2), ...gfVarint(bytes.length), ...bytes];

const gfString = (field, s) => gfBytes(field, [...Buffer.from(s, 'utf8')]);

/**
 * Build the results-page URL. `tfs` is a base64url protobuf with the field
 * numbers decoded by the fast-flights project: 3 = one leg per direction
 * (2 date, 5 max stops, 6 airline, 13/14 origin/destination airport),
 * 8 = one entry per adult, 9 = cabin, 19 = trip type (1 round, 2 one-way).
 */
function buildGfSearchUrl(params) {
  const { origin, destination, departureDate, returnDate, cabinClass, maxStops, airlines, passengers } = params;
  const roundTrip = /^\d{4}-\d{2}-\d{2}$/.test(returnDate || '');
  const adults = Math.max(1, Math.min(parseInt(passengers, 10) || 1, 9));
  const stops = gfMaxStops(maxStops);
  const codes = Array.isArray(airlines) ? airlines.slice().sort() : [];
  const leg = (date, from, to) => gfBytes(3, [
    ...gfString(2, date),
    ...(stops === null ? [] : gfInt(5, stops)),
    ...codes.flatMap(code => gfString(6, code)),
    ...gfBytes(13, gfString(2, from)),
    ...gfBytes(14, gfString(2, to)),
  ]);
  const bytes = [...leg(departureDate, origin, destination)];
  if (roundTrip) bytes.push(...leg(returnDate, destination, origin));
  for (let i = 0; i < adults; i++) bytes.push(...gfInt(8, 1));
  bytes.push(...gfInt(9, gfCabinClass(cabinClass)), ...gfInt(19, roundTrip ? 1 : 2));
  return `${GF_PAGE_URL}?tfs=${Buffer.from(bytes).toString('base64url')}&hl=en&gl=us&curr=USD`;
}

/**
 * Read the shopping payload from a results page. A page without the block is
 * a challenge or an unrecognized page, never an empty result.
 */
function readGfPayload(html) {
  const marker = /AF_initDataCallback\(\{key: 'ds:1',(?: hash: '[^']*',)?\s*data:/.exec(html);
  if (!marker) throw new Error('Google Flights returned a page without flight results');
  const start = marker.index + marker[0].length;
  const close = html.indexOf('</script>', start);
  const block = html.slice(start, close < 0 ? undefined : close);
  // A rejected search (a past date, an unknown airport) carries an ErrorResponse
  // in place of the payload: `data:[…], errorHasStatus: true,});`.
  if (/,\s*errorHasStatus:\s*true/.test(block)) throw new Error('Google Flights rejected the search');
  const end = block.lastIndexOf(', sideChannel:');
  let data;
  try {
    data = JSON.parse(block.slice(0, end));
  } catch {
    throw new Error('Google Flights returned an unreadable results page');
  }
  if (!Array.isArray(data)) throw new Error('Google Flights returned an unrecognized payload');
  return data;
}

/**
 * Parse the flight rows of a results page.
 * Mirrors SearchFlights._parse_flights_data() from fli/search/flights.py.
 */
function parseGfFlights(html) {
  const data = readGfPayload(html);
  const items = [];
  for (const idx of [2, 3]) {
    if (Array.isArray(data?.[idx]) && Array.isArray(data[idx][0])) {
      items.push(...data[idx][0]);
    }
  }

  const pad2 = n => String(n || 0).padStart(2, '0');
  const toIso = (dateArr, timeArr) => {
    if (!Array.isArray(dateArr) || !Array.isArray(timeArr)) return '';
    return `${dateArr[0]}-${pad2(dateArr[1])}-${pad2(dateArr[2])}T${pad2(timeArr[0])}:${pad2(timeArr[1])}`;
  };

  const flights = items.map(item => {
    try {
      const fd = item[0];
      const pd = item[1];
      if (!Array.isArray(fd?.[2]) || fd[2].length === 0) return null;
      const priceArr = pd?.[0];
      const price = Array.isArray(priceArr) ? (priceArr[priceArr.length - 1] ?? 0) : 0;
      const legs = fd[2].map(fl => ({
        airlineCode: fl[22]?.[0] ?? '',
        flightNumber: String(fl[22]?.[1] ?? ''),
        departureAirport: fl[3] ?? '',
        arrivalAirport: fl[6] ?? '',
        departureDatetime: toIso(fl[20], fl[8]),
        arrivalDatetime: toIso(fl[21], fl[10]),
        durationMinutes: fl[11] ?? 0,
      }));
      return { legs, price, durationMinutes: fd[9] ?? 0, stops: Math.max(0, (fd[2]?.length ?? 1) - 1) };
    } catch { return null; }
  }).filter(Boolean);
  if (items.length > 0 && flights.length === 0) {
    throw new Error('Google Flights returned flight rows in an unrecognized shape');
  }
  return flights;
}

// The page has no departure-time filter or sort control in `tfs`; apply both
// here. A round-trip page lists only the outbound legs, so the window filters
// the outbound departure; the return journey is chosen on a later page.
function gfDepartureWindow(window) {
  const parts = String(window || '').split('-').map(n => parseInt(n, 10));
  return parts.length === 2 && parts.every(Number.isInteger) ? parts : null;
}

function gfSortKey(sortBy) {
  switch ((sortBy || '').toUpperCase()) {
    case 'CHEAPEST': case 'PRICE': return f => f.price;
    case 'DEPARTURE_TIME': case 'DEPARTURE': return f => f.legs[0]?.departureDatetime;
    case 'ARRIVAL_TIME': case 'ARRIVAL': return f => f.legs.at(-1)?.arrivalDatetime;
    case 'DURATION': return f => f.durationMinutes;
    default: return null;
  }
}

function selectGfFlights(flights, { departureWindow, sortBy }) {
  const range = gfDepartureWindow(departureWindow);
  const hour = f => parseInt(f.legs[0]?.departureDatetime.slice(11, 13), 10);
  let rows = range ? flights.filter(f => hour(f) >= range[0] && hour(f) < range[1]) : flights.slice();
  const key = gfSortKey(sortBy);
  if (key) rows = rows.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return rows;
}

/**
 * Fetch and parse one results page. Throws `Google Flights returned …` for
 * provider failures and arms the global cooldown on 429.
 */
async function fetchGfFlights(params, signal) {
  const { gfResp, html } = await withGfPageSlot(signal, async () => {
    const gfResp = await fetch(buildGfSearchUrl(params), { headers: GF_HEADERS, signal });
    return { gfResp, html: gfResp.ok ? await gfResp.text() : '' };
  });
  if (gfResp.status === 429) {
    gfGlobal429Until = Date.now() + GF_429_COOLDOWN_MS;
    console.warn(`[Google Flights] 429 — global cooldown ${GF_429_COOLDOWN_MS / 1000}s`);
    incrementRelayMetric('googleFlights429');
    recordRelayOutcome('googleFlights', 'throttle');
    throw new Error(`Google Flights returned ${gfResp.status}`);
  }
  if (gfResp.status === 401 || gfResp.status === 403) {
    recordRelayOutcome('googleFlights', 'authRejection');
    throw new Error(`Google Flights returned ${gfResp.status}`);
  }
  if (!gfResp.ok) {
    recordRelayOutcome('googleFlights', 'terminalFailure');
    throw new Error(`Google Flights returned ${gfResp.status}`);
  }
  try {
    return parseGfFlights(html);
  } catch (err) {
    recordRelayOutcome('googleFlights', 'terminalFailure');
    throw err;
  }
}

function recordGfFailure(err) {
  const isTimeout = err?.name === 'TimeoutError' || err?.name === 'AbortError' || err?.message?.includes('timed out');
  if (isTimeout) {
    recordRelayOutcome('googleFlights', 'timeout');
  } else if (!err?.message?.startsWith('Google Flights')) {
    recordRelayOutcome('googleFlights', 'terminalFailure');
  }
}

function sendGfFailure(res, err, label, emptyKey) {
  console.error(`[Google Flights] ${label} error:`, err?.message || err);
  const retryAfter = Math.max(0, Math.ceil((gfGlobal429Until - Date.now()) / 1000));
  res.writeHead(502, {
    'Content-Type': 'application/json',
    ...(retryAfter > 0 ? { 'Retry-After': String(retryAfter) } : {}),
  });
  res.end(JSON.stringify({ error: err?.message || 'search failed', [emptyKey]: [] }));
}

function sendGfCooldown(res, emptyKey, extra) {
  incrementRelayMetric('googleFlights429');
  recordRelayOutcome('googleFlights', 'throttle');
  const retryAfter = Math.max(1, Math.ceil((gfGlobal429Until - Date.now()) / 1000));
  res.writeHead(200, { 'Content-Type': 'application/json', 'Retry-After': String(retryAfter) });
  res.end(JSON.stringify({ [emptyKey]: [], ...extra, cooldown: true }));
}

async function handleGoogleFlightsSearch(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const origin = (url.searchParams.get('origin') || '').toUpperCase();
    const destination = (url.searchParams.get('destination') || '').toUpperCase();
    const departureDate = url.searchParams.get('departure_date') || '';

    if (!origin || !destination || !departureDate) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin, destination, departure_date required' }));
      return;
    }
    incrementRelayMetric('googleFlightsRequests');

    if (Date.now() < gfGlobal429Until) {
      sendGfCooldown(res, 'flights', {});
      return;
    }

    const params = {
      origin, destination, departureDate,
      returnDate: url.searchParams.get('return_date') || '',
      cabinClass: url.searchParams.get('cabin_class') || '',
      maxStops: url.searchParams.get('max_stops') || '',
      airlines: gfParseAirlines(url.searchParams.getAll('airlines')),
      passengers: url.searchParams.get('passengers') || '1',
    };
    const flights = selectGfFlights(await fetchGfFlights(params, AbortSignal.timeout(GF_PAGE_TIMEOUT_MS)), {
      departureWindow: url.searchParams.get('departure_window') || '',
      sortBy: url.searchParams.get('sort_by') || '',
    });
    recordRelayOutcome('googleFlights', 'success');
    incrementRelayMetric('googleFlightsServed');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ flights }));
  } catch (err) {
    recordGfFailure(err);
    sendGfFailure(res, err, 'search', 'flights');
  }
}

async function handleGoogleFlightsDates(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    const origin = (url.searchParams.get('origin') || '').toUpperCase();
    const destination = (url.searchParams.get('destination') || '').toUpperCase();
    const startDate = url.searchParams.get('start_date') || '';
    const endDate = url.searchParams.get('end_date') || '';

    if (!origin || !destination || !startDate || !endDate) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'origin, destination, start_date, end_date required' }));
      return;
    }

    const roundTrip = url.searchParams.get('is_round_trip') === 'true';
    const tripDuration = parseInt(url.searchParams.get('trip_duration') || '0', 10) || 0;
    if (roundTrip && tripDuration <= 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'trip_duration is required for round-trip date searches' }));
      return;
    }

    const first = Date.parse(`${startDate}T00:00:00Z`);
    const last = Date.parse(`${endDate}T00:00:00Z`);
    const totalDays = Math.round((last - first) / 86_400_000) + 1;
    if (!Number.isFinite(totalDays) || totalDays < 1 || totalDays > GF_DATES_MAX_DAYS) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `date range must contain 1 to ${GF_DATES_MAX_DAYS} days` }));
      return;
    }

    if (Date.now() < gfGlobal429Until) {
      incrementRelayMetric('googleFlightsRequests');
      sendGfCooldown(res, 'dates', { partial: false });
      return;
    }

    const isoDay = time => new Date(time).toISOString().slice(0, 10);
    const filters = {
      cabinClass: url.searchParams.get('cabin_class') || '',
      maxStops: url.searchParams.get('max_stops') || '',
      airlines: gfParseAirlines(url.searchParams.getAll('airlines')),
      passengers: url.searchParams.get('passengers') || '1',
    };
    const departureWindow = url.searchParams.get('departure_window') || '';
    const days = Array.from({ length: totalDays }, (_, i) => first + i * 86_400_000);
    const deadline = AbortSignal.timeout(GF_DATES_DEADLINE_MS);
    const results = new Array(days.length).fill(null);
    let next = 0;
    let firstFailure = '';
    let hasCooldown = false;

    const worker = async () => {
      while (next < days.length) {
        const index = next++;
        if (deadline.aborted) { firstFailure ||= 'Google Flights date search ran out of time'; return; }
        if (Date.now() < gfGlobal429Until) { hasCooldown = true; return; }
        const date = isoDay(days[index]);
        const returnDate = roundTrip ? isoDay(days[index] + tripDuration * 86_400_000) : '';
        incrementRelayMetric('googleFlightsRequests');
        try {
          const signal = AbortSignal.any([deadline, AbortSignal.timeout(GF_PAGE_TIMEOUT_MS)]);
          const flights = selectGfFlights(
            await fetchGfFlights({ origin, destination, departureDate: date, returnDate, ...filters }, signal),
            { departureWindow },
          );
          recordRelayOutcome('googleFlights', 'success');
          incrementRelayMetric('googleFlightsServed');
          const prices = flights.map(f => f.price).filter(price => Number.isFinite(price) && price > 0);
          results[index] = prices.length ? [{ date, returnDate, price: Math.min(...prices) }] : [];
        } catch (err) {
          if (err?.message === 'Google Flights returned 429') hasCooldown = true;
          else recordGfFailure(err);
          firstFailure ||= err?.message || 'date search failed';
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(GF_DATES_CONCURRENCY, days.length) }, worker));

    const answered = results.filter(Boolean);
    // Every day failed outright (each already counted): report the first reason like a single search.
    if (answered.length === 0 && !hasCooldown) {
      sendGfFailure(res, new Error(firstFailure || 'date search failed'), 'dates', 'dates');
      return;
    }
    const dates = answered.flat();
    const partial = answered.length < days.length;
    if (url.searchParams.get('sort_by_price') === 'true') dates.sort((a, b) => a.price - b.price);
    if (partial && dates.length > 0) recordRelayOutcome('googleFlights', 'fallback');

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ dates, partial, cooldown: hasCooldown }));
  } catch (err) {
    recordGfFailure(err);
    sendGfFailure(res, err, 'dates', 'dates');
  }
}

// ─── End Widget Agent ────────────────────────────────────────────────────────

function scheduleUpstreamReconnect() {
  if (relayShuttingDown || upstreamReconnectTimer || !API_KEY) return;
  const throttleEscalated = isAisThrottleEscalated();
  const ceilingMs = throttleEscalated ? AIS_THROTTLE_RECONNECT_MAX_MS : AIS_RECONNECT_MAX_MS;
  // The delay comes from the policy that classified the failure (it is the one
  // place that knows about a Retry-After, the auth probe cadence and the ceiling
  // escalation). The fallback recomputes the plain ladder for the defensive case
  // where a reconnect is requested without a recorded outcome.
  const delayMs = upstreamPendingReconnectDelayMs != null
    ? upstreamPendingReconnectDelayMs
    : nextBackoffMs(aisReconnectPolicy.snapshot().attempts, AIS_RECONNECT_BASE_MS, ceilingMs);
  upstreamPendingReconnectDelayMs = null;
  upstreamReconnectAt = Date.now() + delayMs;
  upstreamReconnectTimer = setTimeout(() => {
    upstreamReconnectTimer = null;
    upstreamReconnectAt = 0;
    connectUpstream();
  }, delayMs);
  upstreamReconnectTimer.unref?.();
  const escalationNote = throttleEscalated
    ? ` [throttle-escalated after ${aisReconnectPolicy.snapshot().consecutiveThrottles} consecutive 429s]`
    : '';
  console.log(`[Relay] AIS reconnect scheduled in ${Math.ceil(delayMs / 1000)}s (attempt=${aisReconnectPolicy.snapshot().attempts})${escalationNote}`);
}

function connectUpstream() {
  if (!API_KEY) return;
  // Snapshot and downstream WebSocket traffic may call this while a provider
  // cooldown is active. Preserve the scheduled exponential backoff instead of
  // letting request traffic turn one upstream 429 into a reconnect storm.
  if (upstreamReconnectTimer) return;

  // The close handler owns socket release. Even CLOSING/CLOSED sockets remain
  // current until that handler clears them, preventing request traffic from
  // replacing a failed socket during the error-to-close gap.
  if (upstreamSocket) return;

  console.log('[Relay] Connecting to aisstream.io...');
  aisUpstreamMetrics.connectionAttempts++;
  const socket = new WebSocket(AISSTREAM_URL, {
    handshakeTimeout: AIS_HANDSHAKE_TIMEOUT_MS,
  });
  let socketServedData = false;
  let socketFailureRecorded = false;
  let socketOpenedAt = 0;
  let socketPositionTimedOut = false;
  let socketHttpStatus = 0;
  let socketRetryAfterMs = null;
  let positionWatchdogTimer = null;
  upstreamSocket = socket;
  upstreamLastPositionAt = 0;
  upstreamLastPositionMono = 0;
  upstreamSocketOpenedMono = 0;
  lastSnapshotAt = 0;
  clearUpstreamQueue();
  upstreamPaused = false;

  // The single place a socket outcome becomes: health telemetry, the failure the
  // reconnect policy sees, and the delay the next attempt uses. Exactly one outcome
  // per socket — `socketFailureRecorded` is the guard, and it is set here so no
  // second site (close after error, or a duplicate error) can double-count.
  const recordUpstreamOutcome = ({
    message = '',
    statusCode = 0,
    retryAfterMs = null,
    servedData = false,
    positionTimedOut = false,
  } = {}) => {
    if (socketFailureRecorded) return null;
    socketFailureRecorded = true;
    const classified = classifyAisFailure({ statusCode, message, retryAfterMs, servedData, positionTimedOut });
    // The relay publishes a distinct label for a close that never carried data.
    // classifyAisFailure cannot know whether this socket served data, so the
    // caller's context supplies that one label; every other label comes from the
    // shared classifier so the two can never disagree about the wording.
    const label = !servedData && !positionTimedOut && !statusCode && !message
      ? 'closed_without_data'
      : classified.label;
    aisUpstreamMetrics[classified.kind === 'rate-limit' ? 'throttle' : 'terminalFailure']++;
    aisUpstreamMetrics.lastFailureAt = Date.now();
    aisUpstreamMetrics.lastFailure = label;
    // Clear the escalation BEFORE computing the delay when this is not a throttle,
    // so an unrelated failure falls straight back to the ordinary ceiling instead
    // of inheriting the throttle block (the ladder itself is unchanged either way).
    if (classified.kind === 'transport') aisReconnectPolicy.onNonThrottleOutcome();
    const outcome = aisReconnectPolicy.onFailure(classified.kind, { retryAfterMs });
    upstreamPendingReconnectDelayMs = outcome.delayMs;
    if (outcome.terminal) {
      console.error(
        `[Relay] Upstream rejected the credential (${label}); probing every `
        + `${Math.round(AIS_AUTH_PROBE_MS / 1000)}s until valid data or a new key`,
      );
    }
    return { ...classified, label, terminal: outcome.terminal };
  };

  const clearPositionWatchdog = () => {
    if (!positionWatchdogTimer) return;
    clearTimeout(positionWatchdogTimer);
    positionWatchdogTimer = null;
  };

  // Release this socket's slot. Shared by the close handler and the
  // unexpected-response handler: both are terminal for the socket, and a second
  // path that forgot one of these fields would wedge the reconnect.
  const releaseUpstreamSocket = () => {
    clearPositionWatchdog();
    upstreamSocket = null;
    upstreamLastPositionAt = 0;
    upstreamLastPositionMono = 0;
    upstreamSocketOpenedMono = 0;
    lastSnapshotAt = 0;
    clearUpstreamQueue();
    upstreamPaused = false;
  };

  const armPositionWatchdog = () => {
    clearPositionWatchdog();
    if (upstreamSocket !== socket || socket.readyState !== WebSocket.OPEN || !socketOpenedAt) return;
    // Monotonic, so an NTP step cannot postpone the recycle of a silent socket.
    const lastPositionOrOpenMono = upstreamLastPositionMono || upstreamSocketOpenedMono;
    const remainingMs = Math.max(1, lastPositionOrOpenMono + AIS_POSITION_FRESHNESS_MS - monoNow());
    positionWatchdogTimer = setTimeout(() => {
      positionWatchdogTimer = null;
      if (upstreamSocket !== socket || socket.readyState !== WebSocket.OPEN) return;
      const latestPositionOrOpenMono = upstreamLastPositionMono || upstreamSocketOpenedMono;
      if (monoNow() - latestPositionOrOpenMono < AIS_POSITION_FRESHNESS_MS) {
        armPositionWatchdog();
        return;
      }
      socketPositionTimedOut = true;
      console.warn(`[Relay] AIS position stream timed out after ${AIS_POSITION_FRESHNESS_MS}ms; reconnecting`);
      // terminate(), never close(): a graceful close on a socket that is already
      // not delivering sits in CLOSING without a 'close' event, so the reconnect
      // never runs and the one-connection-per-key slot stays occupied.
      socket.terminate();
    }, remainingMs);
    positionWatchdogTimer.unref?.();
  };

  const scheduleUpstreamDrain = () => {
    if (upstreamDrainScheduled) return;
    upstreamDrainScheduled = true;
    setImmediate(drainUpstreamQueue);
  };

  const onSubscriptionError = (message) => {
    recordUpstreamOutcome({ message });
    // The key is sent after upgrade, so subscription errors arrive as data.
    // The close handler releases the socket and schedules the classified delay.
    socket.terminate();
  };

  const drainUpstreamQueue = () => {
    if (upstreamSocket !== socket) {
      clearUpstreamQueue();
      upstreamPaused = false;
      return;
    }

    upstreamDrainScheduled = false;
    const startedAt = Date.now();
    let processed = 0;

    while (processed < UPSTREAM_DRAIN_BATCH &&
           getUpstreamQueueSize() > 0 &&
           Date.now() - startedAt < UPSTREAM_DRAIN_BUDGET_MS) {
      const raw = dequeueUpstreamMessage();
      if (!raw) break;
      const acceptedType = processRawUpstreamMessage(raw, onSubscriptionError);
      if (socketFailureRecorded) return;
      if (acceptedType) {
        // A successful WebSocket upgrade or arbitrary JSON frame is not AIS
        // recovery. Only a validated frame accepted into relay state resets
        // provider failure telemetry and reconnect backoff.
        if (!socketServedData) {
          socketServedData = true;
          aisUpstreamMetrics.success++;
          aisUpstreamMetrics.lastSuccessAt = Date.now();
          aisUpstreamMetrics.lastFailure = null;
        }
        // Valid data is the ONLY event that proves the feed works, so it is also
        // the only one that clears the ladder, the throttle escalation and a
        // refused credential.
        aisReconnectPolicy.onAcceptedFrame();
        if (acceptedType === 'position') {
          const wasCurrentPositionReady = getAisPositionFreshness().currentPositionReady;
          const nowMs = Date.now();
          upstreamLastPositionAt = nowMs;
          upstreamLastPositionMono = monoNow();
          armPositionWatchdog();
          if (!wasCurrentPositionReady) lastSnapshotAt = 0;
        }
      }
      processed++;
    }

    const queueSize = getUpstreamQueueSize();
    if (queueSize >= UPSTREAM_QUEUE_HIGH_WATER && !upstreamPaused) {
      upstreamPaused = true;
      socket.pause();
      console.warn(`[Relay] Upstream paused (queue=${queueSize}, dropped=${droppedMessages})`);
    } else if (upstreamPaused && queueSize <= UPSTREAM_QUEUE_LOW_WATER) {
      upstreamPaused = false;
      socket.resume();
      console.log(`[Relay] Upstream resumed (queue=${queueSize})`);
    }

    if (queueSize > 0) scheduleUpstreamDrain();
  };

  socket.on('open', () => {
    // Verify this socket is still the current one (race condition guard)
    if (upstreamSocket !== socket) {
      console.log('[Relay] Stale socket open event, terminating');
      // terminate(), not close(): this socket no longer owns the slot, and a
      // graceful close would leave it in CLOSING holding the one stream per key
      // the provider allows.
      socket.terminate();
      return;
    }
    console.log('[Relay] Connected to aisstream.io');
    socketOpenedAt = Date.now();
    upstreamSocketOpenedMono = monoNow();
    armPositionWatchdog();
    socket.send(JSON.stringify({
      APIKey: API_KEY,
      BoundingBoxes: [[[-90, -180], [90, 180]]],
      // ShipStaticData (AIS Type 5) carries ShipType, which PositionReport
      // does not. Required for tanker classification on the Energy Atlas
      // live-tanker layer — without it, vesselMeta cache stays empty and
      // tankerReports never populates. Static data is broadcast every ~6
      // min per vessel (ITU-R M.1371), so the volume add is small relative
      // to PositionReport (which broadcasts every 2-10s underway).
      FilterMessageTypes: ['PositionReport', 'ShipStaticData'],
    }));
  });

  socket.on('message', (data) => {
    if (upstreamSocket !== socket) return;

    const raw = data instanceof Buffer ? data : Buffer.from(data);
    if (getUpstreamQueueSize() >= UPSTREAM_QUEUE_HARD_CAP) {
      droppedMessages++;
      incrementRelayMetric('drops');
      return;
    }

    enqueueUpstreamMessage(raw);
    if (!upstreamPaused && getUpstreamQueueSize() >= UPSTREAM_QUEUE_HIGH_WATER) {
      upstreamPaused = true;
      socket.pause();
      console.warn(`[Relay] Upstream paused (queue=${getUpstreamQueueSize()}, dropped=${droppedMessages})`);
    }
    scheduleUpstreamDrain();
  });

  socket.on('close', (_code, reason) => {
    if (upstreamSocket === socket) {
      if (!relayShuttingDown && !socketFailureRecorded) {
        const message = reason.toString();
        const failure = classifyAisFailure({ message });
        if (failure.kind !== 'rate-limit') aisReconnectPolicy.onCleanClose();
        recordUpstreamOutcome({
          // A generic policy close can mean a malformed subscription, not auth.
          message: failure.kind === 'transport' ? '' : message,
          servedData: socketServedData,
          positionTimedOut: socketPositionTimedOut,
        });
      }
      releaseUpstreamSocket();
      console.log('[Relay] Disconnected');
      scheduleUpstreamReconnect();
    }
  });

  socket.on('error', (err) => {
    const message = String(err?.message || '');
    // The classifier is what promotes a 401/403 (or AISstream's wording for a bad
    // key) out of the ordinary ladder and into the terminal auth state. A 429 stays
    // a throttle, and anything else stays an ordinary transport failure.
    recordUpstreamOutcome({
      message,
      statusCode: socketHttpStatus,
      retryAfterMs: socketRetryAfterMs,
    });
    console.error('[Relay] Upstream error:', message);
  });

  // `ws` only exposes the upgrade response — and with it Retry-After — through this
  // event, otherwise it emits a generic error and the server's own pacing hint never
  // reaches the ladder. Installing the listener transfers teardown to us: verified
  // against this `ws` version that afterwards NO error and NO close event fires and
  // the socket stays CONNECTING, so a handler that only captured the status would
  // leak the one-connection-per-key slot and silently stop reconnecting. Hence the
  // explicit release + schedule, identical to the close path.
  socket.on('unexpected-response', (req, res) => {
    res.resume();
    req.destroy();
    if (upstreamSocket !== socket) return;
    socketHttpStatus = Number(res?.statusCode) || 0;
    socketRetryAfterMs = parseRetryAfterHeaderMs(res?.headers?.['retry-after']);
    recordUpstreamOutcome({
      statusCode: socketHttpStatus,
      retryAfterMs: socketRetryAfterMs,
      message: `Unexpected server response: ${socketHttpStatus}`,
    });
    if (!relayShuttingDown) {
      releaseUpstreamSocket();
      scheduleUpstreamReconnect();
    }
  });
}

function close() {
  relayShuttingDown = true;
  shutdown.abort();
  for (const timer of timers) { globalThis.clearTimeout(timer); globalThis.clearInterval(timer); }
  timers.clear();
  upstreamSocket?.terminate();
  httpsKeepAliveAgent.destroy();
  if (!UPSTASH_ENABLED) return Promise.resolve();
  return transitTracker.flush(Date.now()).catch(error => console.warn('[Transit] shutdown:', error.message));
}

function start() {
  void startOrefPollLoop().catch(error => console.warn('[OREF]', error.message));
  connectUpstream();
}

const theaterPostureSourceCounts = { opensky: 0, adsbLol: 0, wingbits: 0, vesselOnly: 0 };

let theaterPostureEmptyRejections = 0;

let theaterPostureLastRun = null;

function safeRatio(numerator, denominator) {
  if (!denominator) return 0;
  return Number((numerator / denominator).toFixed(4));
}

function getRelayRollingMetrics() {
  const nowSec = getMetricsNowSec();
  const minSec = nowSec - METRICS_WINDOW_SECONDS + 1;
  pruneRelayMetricsBuckets(nowSec);

  const rollup = createRelayMetricsBucket();
  for (const [sec, bucket] of relayMetricsBuckets) {
    if (sec < minSec) continue;
    rollup.openskyRequests += bucket.openskyRequests;
    rollup.openskyCacheHit += bucket.openskyCacheHit;
    rollup.openskyNegativeHit += bucket.openskyNegativeHit;
    rollup.openskyDedup += bucket.openskyDedup;
    rollup.openskyDedupNeg += bucket.openskyDedupNeg;
    rollup.openskyDedupEmpty += bucket.openskyDedupEmpty;
    rollup.openskyMiss += bucket.openskyMiss;
    rollup.openskyUpstreamFetches += bucket.openskyUpstreamFetches;
    rollup.openskyServed += bucket.openskyServed;
    rollup.openskySuccess += bucket.openskySuccess;
    rollup.openskyThrottle += bucket.openskyThrottle;
    rollup.openskyTimeout += bucket.openskyTimeout;
    rollup.openskyAuthRejection += bucket.openskyAuthRejection;
    rollup.openskyRouteRejection += bucket.openskyRouteRejection;
    rollup.openskyFallback += bucket.openskyFallback;
    rollup.openskyTerminalFailure += bucket.openskyTerminalFailure;
    rollup.drops += bucket.drops;
    rollup.notificationDedupSetNxErrors += bucket.notificationDedupSetNxErrors;
    rollup.notificationDedupSetNxFailOpen += bucket.notificationDedupSetNxFailOpen;
    rollup.notificationDedupSetNxFailClosed += bucket.notificationDedupSetNxFailClosed;
    rollup.googleFlightsRequests += bucket.googleFlightsRequests;
    rollup.googleFlightsServed += bucket.googleFlightsServed;
    rollup.googleFlightsSuccess += bucket.googleFlightsSuccess;
    rollup.googleFlights429 += bucket.googleFlights429;
    rollup.googleFlightsThrottle += bucket.googleFlightsThrottle;
    rollup.googleFlightsTimeout += bucket.googleFlightsTimeout;
    rollup.googleFlightsAuthRejection += bucket.googleFlightsAuthRejection;
    rollup.googleFlightsFallback += bucket.googleFlightsFallback;
    rollup.googleFlightsTerminalFailure += bucket.googleFlightsTerminalFailure;
    rollup.rssRequests += bucket.rssRequests;
    rollup.rssServed += bucket.rssServed;
    rollup.rssSuccess += bucket.rssSuccess;
    rollup.rssThrottle += bucket.rssThrottle;
    rollup.rssTimeout += bucket.rssTimeout;
    rollup.rssAuthRejection += bucket.rssAuthRejection;
    rollup.rssFallback += bucket.rssFallback;
    rollup.rssTerminalFailure += bucket.rssTerminalFailure;
    rollup.aisSnapshotRequests += bucket.aisSnapshotRequests;
    rollup.aisSnapshotServed += bucket.aisSnapshotServed;
    rollup.aisSnapshotSuccess += bucket.aisSnapshotSuccess;
    rollup.aisSnapshotThrottle += bucket.aisSnapshotThrottle;
    rollup.aisSnapshotTimeout += bucket.aisSnapshotTimeout;
    rollup.aisSnapshotAuthRejection += bucket.aisSnapshotAuthRejection;
    rollup.aisSnapshotUnauthorizedClient += bucket.aisSnapshotUnauthorizedClient;
    rollup.aisSnapshotFallback += bucket.aisSnapshotFallback;
    rollup.aisSnapshotTerminalFailure += bucket.aisSnapshotTerminalFailure;
    if (bucket.queueMax > rollup.queueMax) rollup.queueMax = bucket.queueMax;
  }

  const dedupCount = rollup.openskyDedup + rollup.openskyDedupNeg + rollup.openskyDedupEmpty;
  const cacheServedCount = rollup.openskyCacheHit + rollup.openskyNegativeHit + dedupCount;
  const nowMs = Date.now();
  const aisPositionFreshness = getAisPositionFreshness(nowMs);
  const openskyProviderBlocked = nowMs < openskyGlobal429Until;
  const observedOpenSkyCoverage = summarizeServedCoverage({
    requests: rollup.openskyRequests,
    served: rollup.openskyServed,
    minimum: AVIATION_MIN_SERVED_COVERAGE,
  });
  const openskyCoverage = openskyProviderBlocked
    ? { ...observedOpenSkyCoverage, status: 'degraded' }
    : observedOpenSkyCoverage;
  const googleFlightsCoverage = summarizeServedCoverage({
    requests: rollup.googleFlightsRequests,
    served: rollup.googleFlightsServed,
    minimum: AVIATION_MIN_SERVED_COVERAGE,
  });
  const observedAviationCoverage = summarizeServedCoverage({
    requests: rollup.openskyRequests + rollup.googleFlightsRequests,
    served: rollup.openskyServed + rollup.googleFlightsServed,
    minimum: AVIATION_MIN_SERVED_COVERAGE,
  });
  const aviationCoverage = openskyProviderBlocked
    ? { ...observedAviationCoverage, status: 'degraded' }
    : observedAviationCoverage;
  const rssCoverage = summarizeServedCoverage({
    requests: rollup.rssRequests,
    served: rollup.rssServed,
    minimum: RSS_MIN_SERVED_COVERAGE,
  });
  let rssBackoffActive = 0;
  let rssMaxBackoffRemainingMs = 0;
  for (const expiry of rssBackoffUntil.values()) {
    const remaining = Math.max(0, expiry - nowMs);
    if (remaining > 0) {
      rssBackoffActive++;
      rssMaxBackoffRemainingMs = Math.max(rssMaxBackoffRemainingMs, remaining);
    }
  }

  return {
    windowSeconds: METRICS_WINDOW_SECONDS,
    generatedAt: new Date().toISOString(),
    opensky: {
      requests: rollup.openskyRequests,
      hitRatio: safeRatio(cacheServedCount, rollup.openskyRequests),
      dedupRatio: safeRatio(dedupCount, rollup.openskyRequests),
      cacheHits: rollup.openskyCacheHit,
      negativeHits: rollup.openskyNegativeHit,
      dedupHits: dedupCount,
      misses: rollup.openskyMiss,
      upstreamFetches: rollup.openskyUpstreamFetches,
      success: rollup.openskySuccess,
      throttle: rollup.openskyThrottle,
      timeout: rollup.openskyTimeout,
      authRejection: rollup.openskyAuthRejection,
      fallback: rollup.openskyFallback,
      terminalFailure: rollup.openskyTerminalFailure,
      served: rollup.openskyServed,
      coverage: openskyCoverage,
      global429CooldownRemainingMs: Math.max(0, openskyGlobal429Until - nowMs),
      rateLimitRemaining: openskyRateLimitRemaining,
      rateLimitRetryAt: openskyGlobal429Until ? new Date(openskyGlobal429Until).toISOString() : null,
      lastSuccessAt: openskyLastSuccessAt ? new Date(openskyLastSuccessAt).toISOString() : null,
      last429At: openskyLast429At ? new Date(openskyLast429At).toISOString() : null,
      requestSpacingMs: OPENSKY_REQUEST_SPACING_MS,
    },
    ais: {
      enabled: !!API_KEY,
      connected: upstreamSocket?.readyState === WebSocket.OPEN,
      currentPositionReady: aisPositionFreshness.currentPositionReady,
      positionStale: aisPositionFreshness.positionStale,
      positionAgeMs: aisPositionFreshness.positionAgeMs,
      positionFreshnessMs: AIS_POSITION_FRESHNESS_MS,
      positionStaleMs: AIS_POSITION_STALE_MS,
      connectionAttemptsSinceBoot: aisUpstreamMetrics.connectionAttempts,
      successfulConnectionsSinceBoot: aisUpstreamMetrics.success,
      throttlesSinceBoot: aisUpstreamMetrics.throttle,
      terminalFailuresSinceBoot: aisUpstreamMetrics.terminalFailure,
      reconnectFailures: aisReconnectPolicy.snapshot().attempts,
      consecutiveThrottles: aisReconnectPolicy.snapshot().consecutiveThrottles,
      throttleEscalated: isAisThrottleEscalated(),
      reconnectCooldownRemainingMs: Math.max(0, upstreamReconnectAt - nowMs),
      lastSuccessAt: aisUpstreamMetrics.lastSuccessAt
        ? new Date(aisUpstreamMetrics.lastSuccessAt).toISOString()
        : null,
      lastFailureAt: aisUpstreamMetrics.lastFailureAt
        ? new Date(aisUpstreamMetrics.lastFailureAt).toISOString()
        : null,
      lastFailure: aisUpstreamMetrics.lastFailure,
      queueMax: rollup.queueMax,
      currentQueue: getUpstreamQueueSize(),
      drops: rollup.drops,
      dropsPerSec: Number((rollup.drops / METRICS_WINDOW_SECONDS).toFixed(4)),
      upstreamPaused,
    },
    notifications: {
      dedupSetNxErrors: rollup.notificationDedupSetNxErrors,
      dedupSetNxFailOpen: rollup.notificationDedupSetNxFailOpen,
      dedupSetNxFailClosed: rollup.notificationDedupSetNxFailClosed,
    },
    aviation: {
      coverage: aviationCoverage,
      minimumServedCoverage: AVIATION_MIN_SERVED_COVERAGE,
      // Which OpenSky route requests actually take, and whether the origin is refusing
      // this exit IP. routeRejection (403/451) means "flip OPENSKY_ROUTE";
      // providerBlocked (429) means the ACCOUNT is out of credits and no route change
      // can help. `openskyRoute` is the EFFECTIVE route; `openskyRouteRequested` is what
      // OPENSKY_ROUTE asked for, so the two differing is itself the misconfiguration
      // signal (proxy requested, no credential, silently serving direct).
      openskyRoute: OPENSKY_ROUTE,
      openskyRouteRequested: OPENSKY_ROUTE_REQUESTED,
      openskyRouteRejection: rollup.openskyRouteRejection,
      openskyProviderBlocked,
    },
    // Which upstream fed each theater-posture publication cycle, plus empty
    // cycles that were rejected before publication. Kept separate
    // from the opensky route counters above so healthy fallback publication
    // (adsb.lol/Wingbits) is never read as OpenSky recovery (#5945). Unlike
    // the sibling sections these are NOT rolling-window: the seed cadence
    // (~10 min) exceeds the metrics window, so bucketed counts would read
    // all-zero — sourceCountsSinceBoot is process-lifetime and lastRun
    // (with seededAt or attemptedAt) is the current-state signal.
    theaterPosture: {
      lastRun: theaterPostureLastRun,
      sourceCountsSinceBoot: { ...theaterPostureSourceCounts },
      emptyRejectionsSinceBoot: theaterPostureEmptyRejections,
    },
    googleFlights: {
      requests: rollup.googleFlightsRequests,
      served: rollup.googleFlightsServed,
      success: rollup.googleFlightsSuccess,
      throttle429: rollup.googleFlights429,
      throttle: rollup.googleFlightsThrottle,
      timeout: rollup.googleFlightsTimeout,
      authRejection: rollup.googleFlightsAuthRejection,
      fallback: rollup.googleFlightsFallback,
      terminalFailure: rollup.googleFlightsTerminalFailure,
      coverage: googleFlightsCoverage,
      cooldownRemainingMs: Math.max(0, gfGlobal429Until - Date.now()),
    },
    rss: {
      requests: rollup.rssRequests,
      served: rollup.rssServed,
      success: rollup.rssSuccess,
      throttle: rollup.rssThrottle,
      timeout: rollup.rssTimeout,
      authRejection: rollup.rssAuthRejection,
      fallback: rollup.rssFallback,
      terminalFailure: rollup.rssTerminalFailure,
      coverage: rssCoverage,
      backoffActiveFeeds: rssBackoffActive,
      maxBackoffRemainingMs: rssMaxBackoffRemainingMs,
    },
    aisSnapshot: {
      requests: rollup.aisSnapshotRequests,
      served: rollup.aisSnapshotServed,
      success: rollup.aisSnapshotSuccess,
      throttle: rollup.aisSnapshotThrottle,
      timeout: rollup.aisSnapshotTimeout,
      authRejection: rollup.aisSnapshotAuthRejection,
      unauthorizedClient: rollup.aisSnapshotUnauthorizedClient,
      fallback: rollup.aisSnapshotFallback,
      terminalFailure: rollup.aisSnapshotTerminalFailure,
    },
    lifetime: {
      openskyRequests: relayMetricsLifetime.openskyRequests,
      openskyCacheHit: relayMetricsLifetime.openskyCacheHit,
      openskyNegativeHit: relayMetricsLifetime.openskyNegativeHit,
      openskyDedup: relayMetricsLifetime.openskyDedup + relayMetricsLifetime.openskyDedupNeg + relayMetricsLifetime.openskyDedupEmpty,
      openskyMiss: relayMetricsLifetime.openskyMiss,
      openskyUpstreamFetches: relayMetricsLifetime.openskyUpstreamFetches,
      openskyServed: relayMetricsLifetime.openskyServed,
      openskySuccess: relayMetricsLifetime.openskySuccess,
      openskyThrottle: relayMetricsLifetime.openskyThrottle,
      openskyTimeout: relayMetricsLifetime.openskyTimeout,
      openskyAuthRejection: relayMetricsLifetime.openskyAuthRejection,
      openskyFallback: relayMetricsLifetime.openskyFallback,
      openskyTerminalFailure: relayMetricsLifetime.openskyTerminalFailure,
      drops: relayMetricsLifetime.drops,
      notificationDedupSetNxErrors: relayMetricsLifetime.notificationDedupSetNxErrors,
      notificationDedupSetNxFailOpen: relayMetricsLifetime.notificationDedupSetNxFailOpen,
      notificationDedupSetNxFailClosed: relayMetricsLifetime.notificationDedupSetNxFailClosed,
      queueMax: relayMetricsQueueMaxLifetime,
      googleFlightsRequests: relayMetricsLifetime.googleFlightsRequests,
      googleFlightsServed: relayMetricsLifetime.googleFlightsServed,
      googleFlightsSuccess: relayMetricsLifetime.googleFlightsSuccess,
      googleFlights429: relayMetricsLifetime.googleFlights429,
      googleFlightsThrottle: relayMetricsLifetime.googleFlightsThrottle,
      googleFlightsTimeout: relayMetricsLifetime.googleFlightsTimeout,
      googleFlightsAuthRejection: relayMetricsLifetime.googleFlightsAuthRejection,
      googleFlightsFallback: relayMetricsLifetime.googleFlightsFallback,
      googleFlightsTerminalFailure: relayMetricsLifetime.googleFlightsTerminalFailure,
      rssRequests: relayMetricsLifetime.rssRequests,
      rssServed: relayMetricsLifetime.rssServed,
      rssSuccess: relayMetricsLifetime.rssSuccess,
      rssThrottle: relayMetricsLifetime.rssThrottle,
      rssTimeout: relayMetricsLifetime.rssTimeout,
      rssAuthRejection: relayMetricsLifetime.rssAuthRejection,
      rssFallback: relayMetricsLifetime.rssFallback,
      rssTerminalFailure: relayMetricsLifetime.rssTerminalFailure,
      aisSnapshotRequests: relayMetricsLifetime.aisSnapshotRequests,
      aisSnapshotServed: relayMetricsLifetime.aisSnapshotServed,
      aisSnapshotSuccess: relayMetricsLifetime.aisSnapshotSuccess,
      aisSnapshotThrottle: relayMetricsLifetime.aisSnapshotThrottle,
      aisSnapshotTimeout: relayMetricsLifetime.aisSnapshotTimeout,
      aisSnapshotAuthRejection: relayMetricsLifetime.aisSnapshotAuthRejection,
      aisSnapshotUnauthorizedClient: relayMetricsLifetime.aisSnapshotUnauthorizedClient,
      aisSnapshotFallback: relayMetricsLifetime.aisSnapshotFallback,
      aisSnapshotTerminalFailure: relayMetricsLifetime.aisSnapshotTerminalFailure,
    },
  };
}

function health() {
  const ingestion = getRelayRollingMetrics();
  const ais = ingestion.ais;
  const hasData = vessels.size > 0;
  const degraded = ais.enabled && (!ais.connected || !ais.currentPositionReady || !hasData);
  const status = degraded || ingestion.aviation.coverage.status === 'degraded' || ingestion.rss.coverage.status === 'degraded' ? 'degraded' : 'ok';
  return { status, messages: messageCount, connected: ais.connected, vessels: vessels.size,
    ingestion: { aviation: ingestion.aviation, rss: ingestion.rss, status, aisSnapshot: { ...ingestion.aisSnapshot, enabled: ais.enabled,
      status: !ais.enabled ? 'disabled' : degraded ? 'degraded' : 'ok', connected: ais.connected,
      hasData, ...getAisPositionFreshness(), positionStaleMs: AIS_POSITION_STALE_MS, upstream: ais } },
  };
}
return { start, close, health, diagnostics: getRelayRollingMetrics, pollOref: orefFetchAlerts, handle: (req, res) => handleProviderRequest(req, res).catch(error => handleRelayRequestFailure(res, error)) };
};
