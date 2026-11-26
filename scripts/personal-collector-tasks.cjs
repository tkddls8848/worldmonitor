// One-shot producers formerly coupled to the hosted relay. Scheduling belongs to personal-collect.
module.exports.createPersonalCollectorTasks = function createPersonalCollectorTasks() {
const http = require('http');

const https = require('https');

const { parseProxyConfig, resolveProxyString, resolveProxyStringForAttempt } = require('./_proxy-utils.cjs');

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
  YahooQuoteSummaryClient,
  buildSectorSeedMeta,
  buildSectorValuationCoverage,
  buildSectorValuationPublication,
  collectSectorValuations,
} = require('./_yahoo-sector-valuations.cjs');

const {
  buildDedupMaterial,
  classifySetNxResult,
  recordDedupOutcome,
} = require('./shared/notification-dedup.cjs');

const { recordPizzintHistory } = require('./shared/pizzint-history.cjs');

const { pizzintVenuePoint } = require('./shared/pizzint-location.cjs');

const { PREVIOUS_SESSION_CHART_QUERY, awaitsSessionOpen, previousSessionClose } = require('./shared/yahoo-closed-session.cjs');

const { CORRIDOR_RISK_NAME_MAP, deriveCorridorRiskLevel } = require('../shared/corridor-risk.js');

const parseProxyUrl = parseProxyConfig;

const RELAY_LOG_THROTTLE_MS = Math.max(1000, Number(process.env.RELAY_LOG_THROTTLE_MS || 10000));

const PROXY_URL = process.env.PROXY_URL || '';

// ─────────────────────────────────────────────────────────────
// Upstash Redis REST helpers — persist OREF history across restarts
// ─────────────────────────────────────────────────────────────
const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';

const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';

// Self-hosted deployments front Redis with a plain-http REST proxy
// (scripts/local/redis-rest-proxy.mjs) reachable only inside the compose network —
// there's no TLS to terminate and no public exposure, so the https-only
// requirement below (which exists to stop a *real* Upstash bearer token from
// transiting the public internet in cleartext) doesn't apply there. This
// gate stayed https-only after the local proxy shipped, so every seed loop
// in this file silently no-ops against http://redis-rest:80 (see
// SELF_HOSTING.md's redis-rest command allowlist note + 4+ days of
// "[TransitSummary]"/"[CorridorRisk]"/etc. never firing).
// UPSTASH_ALLOW_INSECURE_HTTP is an explicit, off-by-default opt-in (never
// inferred from hostname/URL shape) so a genuine Upstash misconfiguration in
// production can't silently downgrade to plaintext.
const UPSTASH_ALLOW_INSECURE_HTTP = process.env.UPSTASH_ALLOW_INSECURE_HTTP === 'true';

const UPSTASH_ENABLED = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);

// Node's https module can't speak to a plain-http endpoint — resolve the
// matching client once at startup instead of hardcoding https.request at
// each upstash* call site below.
const UPSTASH_HTTP_MODULE = UPSTASH_REDIS_REST_URL.startsWith('http://') ? http : https;

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

function upstashExpire(key, ttlSeconds) {
  return new Promise((resolve) => {
    if (!UPSTASH_ENABLED) return resolve(false);
    const url = new URL('/', UPSTASH_REDIS_REST_URL);
    const body = JSON.stringify(['EXPIRE', key, String(ttlSeconds)]);
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
          resolve(parsed?.result === 1);
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

 // key: route:ip -> { count, resetAt }
const logThrottleState = new Map();

const SAT_SEED_TTL = 21_600;

 // 6h — survives 3 missed cycles before data expires
const SAT_RETRY_MS = 20 * 60 * 1000;

 // retry 20min after failure instead of waiting 120min
const SAT_GROUPS = ['military', 'resource'];

const SAT_NAME_FILTERS = [
  /^YAOGAN/i, /^GAOFEN/i, /^JILIN/i,
  /^COSMOS 2[4-9]\d{2}/i,
  /^COSMO-SKYMED/i, /^TERRASAR/i, /^PAZ$/i, /^SAR-LUPE/i,
  /^WORLDVIEW/i, /^SKYSAT/i, /^PLEIADES/i, /^KOMPSAT/i,
  /^SAPPHIRE/i, /^PRAETORIAN/i,
  /^SENTINEL/i,
  /^CARTOSAT/i,
  /^GOKTURK/i, /^RASAT/i,
  /^USA[ -]?\d/i,
  /^ZIYUAN/i,
];

function satClassify(name) {
  const n = name.toUpperCase();
  let type = 'military';
  if (/COSMO-SKYMED|TERRASAR|PAZ|SAR-LUPE|YAOGAN/i.test(n)) type = 'sar';
  else if (/WORLDVIEW|SKYSAT|PLEIADES|KOMPSAT|GAOFEN|JILIN|CARTOSAT|ZIYUAN/i.test(n)) type = 'optical';
  else if (/SAPPHIRE|PRAETORIAN|USA|GOKTURK/i.test(n)) type = 'military';

  let country = 'OTHER';
  if (/^YAOGAN|^GAOFEN|^JILIN|^ZIYUAN/i.test(n)) country = 'CN';
  else if (/^COSMOS/i.test(n)) country = 'RU';
  else if (/^WORLDVIEW|^SAPPHIRE|^PRAETORIAN|^USA|^SKYSAT/i.test(n)) country = 'US';
  else if (/^SENTINEL|^COSMO-SKYMED|^TERRASAR|^SAR-LUPE|^PAZ|^PLEIADES/i.test(n)) country = 'EU';
  else if (/^KOMPSAT/i.test(n)) country = 'KR';
  else if (/^CARTOSAT/i.test(n)) country = 'IN';
  else if (/^GOKTURK|^RASAT/i.test(n)) country = 'TR';

  return { type, country };
}

let satSeedInFlight = false;

let satRetryTimer = null;

async function seedSatelliteTLEs() {
  if (satSeedInFlight) return;
  satSeedInFlight = true;
  if (satRetryTimer) { clearTimeout(satRetryTimer); satRetryTimer = null; }
  const t0 = Date.now();
  try {
    const byNorad = new Map();

    for (const group of SAT_GROUPS) {
      let text;
      try {
        text = await new Promise((resolve, reject) => {
          const url = new URL(`https://celestrak.org/NORAD/elements/gp.php?GROUP=${group}&FORMAT=tle`);
          const req = https.request(url, { signal: AbortSignal.timeout(15000), method: 'GET', headers: { 'User-Agent': CHROME_UA }, timeout: 15000 }, (resp) => {
            if (resp.statusCode < 200 || resp.statusCode >= 300) {
              resp.resume();
              return reject(new Error(`CelesTrak ${group}: HTTP ${resp.statusCode}`));
            }
            let data = '';
            let size = 0;
            resp.on('data', (chunk) => {
              size += chunk.length;
              if (size > 2 * 1024 * 1024) { req.destroy(); return reject(new Error(`CelesTrak ${group}: payload > 2MB`)); }
              data += chunk;
            });
            resp.on('end', () => resolve(data));
          });
          req.on('error', reject);
          req.on('timeout', () => { req.destroy(); reject(new Error(`CelesTrak ${group}: timeout`)); });
          req.end();
        });
      } catch (e) {
        console.warn(`[Satellites] Skipping group ${group}:`, e?.message || e);
        continue;
      }

      const lines = text.split('\n').map(l => l.trimEnd());
      for (let i = 0; i < lines.length - 2; i++) {
        const l1 = lines[i + 1];
        const l2 = lines[i + 2];
        if (!l1.startsWith('1 ') || !l2.startsWith('2 ')) continue;
        if (l1.length !== 69 || l2.length !== 69) continue;
        const name = lines[i].trim();
        const noradId = l1.substring(2, 7).trim();
        if (!byNorad.has(noradId)) {
          byNorad.set(noradId, { noradId, name, line1: l1, line2: l2 });
        }
        i += 2;
      }
    }

    const satellites = [];
    for (const sat of byNorad.values()) {
      if (!SAT_NAME_FILTERS.some(rx => rx.test(sat.name))) continue;
      const { type, country } = satClassify(sat.name);
      satellites.push({ ...sat, type, country });
    }

    if (satellites.length === 0) {
      console.warn('[Satellites] No matching TLEs found — extending existing key TTL, retrying in 20min');
      try { await upstashExpire('intelligence:satellites:tle:v1', SAT_SEED_TTL); } catch {}

      return;
    }

    const payload = { satellites, fetchedAt: Date.now() };
    const ok = await envelopeWrite('intelligence:satellites:tle:v1', payload, SAT_SEED_TTL, { recordCount: satellites.length, sourceVersion: 'celestrak' });
    await upstashSet('seed-meta:intelligence:satellites', { fetchedAt: Date.now(), recordCount: satellites.length }, 604800);
    console.log(`[Satellites] Seeded ${satellites.length} TLEs (redis: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[Satellites] Seed error:', e?.message || e, '— extending existing key TTL, retrying in 20min');
    try { await upstashExpire('intelligence:satellites:tle:v1', SAT_SEED_TTL); } catch {}

  } finally {
    satSeedInFlight = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Market Data Seed — Railway fetches Yahoo/Finnhub → writes to Redis
// so Vercel handlers serve from cache (avoids Yahoo 429 from Vercel IPs)
// ─────────────────────────────────────────────────────────────
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY || '';

 // 5 min
const MARKET_SEED_TTL = 7200;

const SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];

// CommonJS cannot import finiteObservation from _seed-utils.mjs. The relay test
// keeps this boundary guard aligned with the cron seeder.
function _finiteObservation(value) {
  if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function _parseYahooChartJson(body) {
  try {
    const data = JSON.parse(body);
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;
    const price = _finiteObservation(meta.regularMarketPrice);
    if (price == null) return null;
    const prevClose = [meta.chartPreviousClose, meta.previousClose]
      .map(_finiteObservation)
      .find((value) => value != null && value !== 0) ?? price;
    const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    const closes = result.indicators?.quote?.[0]?.close;
    const sparkline = Array.isArray(closes)
      ? closes
        .map(_finiteObservation)
        .filter((value) => value != null)
        .map((value) => (value !== 0 ? Number(value.toPrecision(7)) : value))
      : [];
    return {
      price,
      change,
      sparkline,
      awaitingSessionOpen: awaitsSessionOpen(data),
      lastTradeAt: meta.regularMarketTime,
      chart: data,
    };
  } catch { return null; }
}

// Two independent Decodo egress pools → two independent cooldowns. Yahoo may
// block one while the other is healthy (2026-04-16: CONNECT blocked, curl OK).
// Sharing state would let one route's outage suppress the working route.
const _YAHOO_PROXY_COOLDOWN_MS = 5 * 60 * 1000;

let _yahooConnectProxyFailCount = 0;

   // fetchYahooChartDirect via gate.decodo.com (CONNECT)
let _yahooConnectProxyCooldownUntil = 0;

function _fetchYahooChartNoProxy(symbol, query = '') {
  return new Promise((resolve) => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${query}`;
    const req = https.get(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
      timeout: 10000,
    }, (resp) => {
      if (resp.statusCode !== 200) {
        resp.resume();
        logThrottled('warn', `market-yahoo-${resp.statusCode}:${symbol}`, `[Market] Yahoo ${symbol} HTTP ${resp.statusCode}`);
        return resolve(null);
      }
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => resolve(_parseYahooChartJson(body)));
    });
    req.on('error', (err) => { logThrottled('warn', `market-yahoo-err:${symbol}`, `[Market] Yahoo ${symbol} error: ${err.message}`); resolve(null); });
    req.on('timeout', () => { req.destroy(); logThrottled('warn', `market-yahoo-timeout:${symbol}`, `[Market] Yahoo ${symbol} timeout`); resolve(null); });
  });
}

// A rolled chart's previous close stays the same until the next trade, so one
// daily-chart request per symbol covers a whole weekend of 5-minute cycles.
const _previousSessionCloses = new Map();

async function _withPreviousSessionChange(symbol, quote) {
  let cached = _previousSessionCloses.get(symbol);
  if (cached?.lastTradeAt !== quote.lastTradeAt) {
    await sleep(150);
    const daily = await _fetchYahooChartOnce(symbol, PREVIOUS_SESSION_CHART_QUERY);
    const close = previousSessionClose(daily?.chart, quote.lastTradeAt);
    if (!close) return quote;
    cached = { lastTradeAt: quote.lastTradeAt, close };
    _previousSessionCloses.set(symbol, cached);
  }
  return { ...quote, change: ((quote.price - cached.close) / cached.close) * 100 };
}

function fetchYahooChartDirect(symbol, query = '') {
  return _fetchYahooChartOnce(symbol, query)
    .then((quote) => (!query && quote?.awaitingSessionOpen ? _withPreviousSessionChange(symbol, quote) : quote));
}

function _fetchYahooChartOnce(symbol, query = '') {
  return _fetchYahooChartNoProxy(symbol, query).then((result) => {
    if (result) return result;
    if (!PROXY_URL) return null;
    if (Date.now() < _yahooConnectProxyCooldownUntil) return null;
    const proxy = { ...parseProxyUrl(PROXY_URL), tls: true };
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}${query}`;
    return fetchViaProxy(url, proxy).then((resp) => {
      if (!resp?.ok) {
        _yahooConnectProxyFailCount++;
        if (_yahooConnectProxyFailCount >= 5) {
          _yahooConnectProxyCooldownUntil = Date.now() + _YAHOO_PROXY_COOLDOWN_MS;
          _yahooConnectProxyFailCount = 0;
          logThrottled('warn', 'market-yahoo-proxy-cooldown', '[Market] Yahoo CONNECT proxy cooldown 5min after 5 failures');
        }
        return null;
      }
      _yahooConnectProxyFailCount = 0;
      return _parseYahooChartJson(resp.body);
    }).catch(() => null);
  });
}

// Yahoo quoteSummary now requires a cookie + crumb session. The client caches
// that session, refreshes it once on 401, then cools the whole route down so a
// single auth failure cannot produce 12 direct + 12 proxy retries per cycle.
// The Decodo fallback performs the same authenticated handshake through curl;
// proxy credentials remain process-local and are never included in logs.
const _yahooQuoteSummaryClient = new YahooQuoteSummaryClient({
  userAgent: CHROME_UA,
  resolveProxyString,
  // Yahoo's quote fundamentals cache is populated per residential exit IP, so a
  // 200 response can omit trailingPE for a stable subset of ETFs no matter how
  // often the same exit is retried. Rotation is the only recovery.
  resolveProxyStringForAttempt,
  cooldownMs: _YAHOO_PROXY_COOLDOWN_MS,
  logger: {
    warn(message, { transport }) {
      logThrottled('warn', `sector-yahoo-auth-${transport}`, message);
    },
  },
});

function fetchYahooQuoteSummary(symbol) {
  return _yahooQuoteSummaryClient.fetch(symbol);
}

function parseSectorValuation(raw) {
  if (!raw) return null;
  const num = (v) => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const tpe = num(typeof raw.trailingPE === 'string' ? parseFloat(raw.trailingPE) : raw.trailingPE);
  const fpe = num(typeof raw.forwardPE === 'string' ? parseFloat(raw.forwardPE) : raw.forwardPE);
  const beta = num(typeof raw.beta === 'string' ? parseFloat(raw.beta) : raw.beta);
  const ytd = num(typeof raw.ytdReturn === 'string' ? parseFloat(raw.ytdReturn) : raw.ytdReturn);
  const y3 = num(typeof raw.threeYearReturn === 'string' ? parseFloat(raw.threeYearReturn) : raw.threeYearReturn);
  const y5 = num(typeof raw.fiveYearReturn === 'string' ? parseFloat(raw.fiveYearReturn) : raw.fiveYearReturn);
  if (tpe === null && fpe === null) return null;
  return { trailingPE: tpe, forwardPE: fpe, beta, ytdReturn: ytd, threeYearReturn: y3, fiveYearReturn: y5 };
}

function fetchFinnhubQuoteDirect(symbol, apiKey) {
  return new Promise((resolve) => {
    const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}`;
    const req = https.get(url, {
      signal: AbortSignal.timeout(10000),
      headers: { 'User-Agent': CHROME_UA, Accept: 'application/json', 'X-Finnhub-Token': apiKey },
      timeout: 10000,
    }, (resp) => {
      if (resp.statusCode !== 200) {
        resp.resume();
        return resolve(null);
      }
      let body = '';
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (data.c === 0 && data.h === 0 && data.l === 0) return resolve(null);
          resolve({ price: data.c, changePercent: data.dp });
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function seedSectorSummary() {
  const sectors = [];

  if (FINNHUB_API_KEY) {
    const results = await Promise.all(SECTOR_SYMBOLS.map((s) => fetchFinnhubQuoteDirect(s, FINNHUB_API_KEY)));
    for (let i = 0; i < SECTOR_SYMBOLS.length; i++) {
      const r = results[i];
      if (r) sectors.push({ symbol: SECTOR_SYMBOLS[i], name: SECTOR_SYMBOLS[i], change: r.changePercent });
    }
  }

  if (sectors.length === 0) {
    for (const s of SECTOR_SYMBOLS) {
      const yahoo = await fetchYahooChartDirect(s);
      if (yahoo) sectors.push({ symbol: s, name: s, change: yahoo.change });
      await sleep(150);
    }
  }

  if (sectors.length === 0) {
    console.warn('[Market] No sector data fetched — skipping Redis write');
    return 0;
  }

  const {
    valuations,
    valuationSources,
    valuationCount: valCount,
    unavailableSymbols,
    valuationDiagnostics,
    currentValuationCount,
    lastGoodFetchedAt,
    lastGoodMetricsUsed,
    lastGoodValuationSymbols,
  } = await collectSectorValuations({
    symbols: SECTOR_SYMBOLS,
    fetchValue: fetchYahooQuoteSummary,
    fetchValueDetailed: (symbol, options) => _yahooQuoteSummaryClient.fetchDetailed(symbol, options),
    parseValue: parseSectorValuation,
    sleepFn: sleep,
    v7UserAgent: CHROME_UA,
    v7ResolveProxyString: resolveProxyString,
    v7Client: _yahooQuoteSummaryClient,
    upstashGet,
    upstashSet,
  });

  const valuationCoverage = buildSectorValuationCoverage({
    valuationCount: valCount,
    expectedCount: SECTOR_SYMBOLS.length,
    fetchedAt: Date.now(),
    sources: valuationSources,
    unavailableSymbols,
    valuationDiagnostics,
    currentValuationCount,
    lastGoodFetchedAt,
    lastGoodMetricsUsed,
    lastGoodValuationSymbols,
  });
  const { payload, meta: sectorMeta } = buildSectorValuationPublication({
    sectors,
    valuations,
    valuationCoverage,
  });
  const ok = await envelopeWrite('market:sectors:v2', payload, MARKET_SEED_TTL, { recordCount: sectors.length, sourceVersion: 'market-sectors' });
  const quotesKey = `market:quotes:v1:${[...SECTOR_SYMBOLS].sort().join(',')}`;
  const sectorQuotes = sectors.map((s) => ({
    symbol: s.symbol, name: s.name, display: s.name,
    price: 0, change: s.change, sparkline: [],
  }));
  const quotesPayload = { quotes: sectorQuotes, finnhubSkipped: false, skipReason: '', rateLimited: false };
  const ok2 = await envelopeWrite(quotesKey, quotesPayload, MARKET_SEED_TTL, { recordCount: sectorQuotes.length, sourceVersion: 'market-sectors' });
  const persistedSectorMeta = buildSectorSeedMeta(sectorMeta, ok);
  const ok3 = await upstashSet('seed-meta:market:sectors', persistedSectorMeta, 604800);
  // valCount includes records replayed from the last-good snapshot, so report
  // the live count alongside it: "12/12 (partial)" during a total upstream
  // outage reads as healthy coverage to anyone scanning the logs.
  const liveCount = currentValuationCount == null ? valCount : currentValuationCount;
  const valuationSummary = liveCount === valCount
    ? `${valCount}/${SECTOR_SYMBOLS.length} valuations`
    : `${valCount}/${SECTOR_SYMBOLS.length} valuations (${liveCount} live, ${valCount - liveCount} stale)`;
  console.log(`[Market] Seeded ${sectors.length}/${SECTOR_SYMBOLS.length} sectors, ${valuationSummary} (${valuationCoverage.sourceStatus}; redis: ${ok && ok2 && ok3 ? 'OK' : 'PARTIAL'})`);
  return sectors.length;
}

// ─────────────────────────────────────────────────────────────
// GSCPI seed — NY Fed Global Supply Chain Pressure Index
// CSV fetched from newyorkfed.org (no API key required).
// Published monthly; seeded daily to catch fresh releases.
// Stored in FRED-compatible format under economic:fred:v1:GSCPI:0
// so the existing GetFredSeriesBatch RPC serves it without changes.
// ─────────────────────────────────────────────────────────────

const GSCPI_SEED_TTL = 259200;

 // 72h — 3x 24h interval; survives 2 missed cycles
const GSCPI_RETRY_MS = 20 * 60 * 1000;

 // 24h
const GSCPI_REDIS_KEY = 'economic:fred:v1:GSCPI:0';

 // FRED-compatible key
const GSCPI_CSV_URL = 'https://www.newyorkfed.org/medialibrary/research/interactives/data/gscpi/gscpi_interactive_data.csv';

let gscpiSeedInFlight = false;

let gscpiRetryTimer = null;

function parseGscpiCsv(text) {
  const MONTH_MAP = {
    Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
    Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
  };
  const lines = text.trim().split('\n').filter(l => l.trim() && !l.startsWith(','));
  const observations = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const dateStr = cols[0]?.trim();
    if (!dateStr) continue;
    // Find last non-empty, non-#N/A value (latest vintage estimate)
    let value = null;
    for (let j = cols.length - 1; j >= 1; j--) {
      const v = cols[j]?.trim();
      if (v && v !== '#N/A' && v !== '') {
        const num = parseFloat(v);
        if (!Number.isNaN(num)) { value = num; break; }
      }
    }
    if (value === null) continue;
    // Parse "31-Jan-2026" → "2026-01-01"
    const parts = dateStr.split('-');
    if (parts.length !== 3) continue;
    const mon = MONTH_MAP[parts[1]];
    const year = parts[2];
    if (!mon || !year) continue;
    observations.push({ date: `${year}-${mon}-01`, value });
  }
  // Return oldest-first (FRED convention)
  return observations.sort((a, b) => a.date.localeCompare(b.date));
}

async function seedGscpi() {
  if (gscpiSeedInFlight) return;
  gscpiSeedInFlight = true;
  if (gscpiRetryTimer) { clearTimeout(gscpiRetryTimer); gscpiRetryTimer = null; }
  try {
    let text;
    try {
      const resp = await fetch(GSCPI_CSV_URL, {
        headers: { 'User-Agent': CHROME_UA, Accept: 'text/csv,text/plain' },
        signal: AbortSignal.timeout(20000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      text = await resp.text();
    } catch (directErr) {
      if (!PROXY_URL) throw directErr;
      console.warn(`[GSCPI] Direct failed (${directErr.message}) — retrying via proxy`);
      const { proxyFetch } = require('./_proxy-utils.cjs');
      const proxy = { ...parseProxyUrl(PROXY_URL), tls: true };
      const result = await proxyFetch(GSCPI_CSV_URL, proxy, {
        accept: 'text/csv,text/plain', headers: { 'User-Agent': CHROME_UA }, timeoutMs: 20_000,
      });
      if (!result.ok) throw new Error(`Proxy HTTP ${result.status}`);
      text = result.buffer.toString('utf8');
    }
    const observations = parseGscpiCsv(text);
    if (observations.length === 0) {
      console.warn('[GSCPI] No data parsed — extending TTL, retrying in 20min');
      try { await upstashExpire(GSCPI_REDIS_KEY, GSCPI_SEED_TTL); } catch {}

      return;
    }
    const latest = observations[observations.length - 1];
    const payload = {
      series: {
        series_id: 'GSCPI',
        title: 'Global Supply Chain Pressure Index',
        units: 'Standard Deviations',
        frequency: 'Monthly',
        observations,
      },
    };
    await envelopeWrite(GSCPI_REDIS_KEY, payload, GSCPI_SEED_TTL, { recordCount: observations.length, sourceVersion: 'nyfed-gscpi' });
    await upstashSet('seed-meta:economic:gscpi', { fetchedAt: Date.now(), recordCount: observations.length }, 604800);
    console.log(`[GSCPI] Seeded ${observations.length} months; latest ${latest.date} = ${latest.value.toFixed(2)}`);
  } catch (e) {
    console.warn('[GSCPI] Seed error:', e?.message, '— extending TTL, retrying in 20min');
    try { await upstashExpire(GSCPI_REDIS_KEY, GSCPI_SEED_TTL); } catch {}

  } finally {
    gscpiSeedInFlight = false;
  }
}

 // 6h
const TECH_EVENTS_TTL_SECONDS = 86400;

 // 24h safety net
const TECH_EVENTS_REDIS_KEY = 'research:tech-events:v1';

const TECH_EVENTS_BOOTSTRAP_KEY = 'research:tech-events-bootstrap:v1';

const TECH_EVENTS_ICS_URL = 'https://www.techmeme.com/newsy_events.ics';

const TECH_EVENTS_RSS_URL = 'https://dev.events/rss.xml';

function techEventsParseICS(icsText) {
  const events = [];
  const blocks = icsText.split('BEGIN:VEVENT').slice(1);
  for (const block of blocks) {
    const summaryMatch = block.match(/SUMMARY:(.+)/);
    const locationMatch = block.match(/LOCATION:(.+)/);
    const dtstartMatch = block.match(/DTSTART;VALUE=DATE:(\d+)/);
    const dtendMatch = block.match(/DTEND;VALUE=DATE:(\d+)/);
    const urlMatch = block.match(/URL:(.+)/);
    const uidMatch = block.match(/UID:(.+)/);
    if (!summaryMatch || !dtstartMatch) continue;
    const summary = summaryMatch[1].trim();
    const location = locationMatch ? locationMatch[1].trim() : '';
    const startDate = dtstartMatch[1];
    const endDate = dtendMatch ? dtendMatch[1] : startDate;
    let type = 'other';
    if (summary.startsWith('Earnings:')) type = 'earnings';
    else if (summary.startsWith('IPO')) type = 'ipo';
    else if (location) type = 'conference';
    events.push({
      id: uidMatch ? uidMatch[1].trim() : '',
      title: summary,
      type,
      location,
      startDate: `${startDate.slice(0, 4)}-${startDate.slice(4, 6)}-${startDate.slice(6, 8)}`,
      endDate: `${endDate.slice(0, 4)}-${endDate.slice(4, 6)}-${endDate.slice(6, 8)}`,
      url: urlMatch ? urlMatch[1].trim() : '',
      source: 'techmeme',
      description: '',
    });
  }
  return events;
}

function techEventsParseRSS(rssText) {
  const events = [];
  const itemMatches = rssText.matchAll(/<item>([\s\S]*?)<\/item>/g);
  for (const match of itemMatches) {
    const item = match[1];
    const titleMatch = item.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>|<title>(.*?)<\/title>/);
    const linkMatch = item.match(/<link>(.*?)<\/link>/);
    const descMatch = item.match(/<description><!\[CDATA\[(.*?)\]\]><\/description>|<description>(.*?)<\/description>/s);
    const guidMatch = item.match(/<guid[^>]*>(.*?)<\/guid>/);
    const title = titleMatch ? (titleMatch[1] ?? titleMatch[2]) : null;
    if (!title) continue;
    const link = linkMatch ? linkMatch[1] || '' : '';
    const description = descMatch ? (descMatch[1] ?? descMatch[2] ?? '') : '';
    const guid = guidMatch ? guidMatch[1] || '' : '';
    const dateMatch = description.match(/on\s+(\w+\s+\d{1,2},?\s+\d{4})/i);
    let startDate = null;
    if (dateMatch) {
      const parsed = new Date(dateMatch[1]);
      if (!Number.isNaN(parsed.getTime())) startDate = parsed.toISOString().split('T')[0];
    }
    if (!startDate) continue;
    if (new Date(startDate) < new Date(new Date().toISOString().split('T')[0])) continue;
    let location = null;
    const locMatch = description.match(/(?:in|at)\s+([A-Za-z\s]+,\s*[A-Za-z\s]+)(?:\.|$)/i) ||
                     description.match(/Location:\s*([^<\n]+)/i);
    if (locMatch) location = locMatch[1].trim();
    if (description.toLowerCase().includes('online')) location = 'Online';
    events.push({
      id: guid || `dev-events-${title.slice(0, 20)}`,
      title,
      type: 'conference',
      location: location || '',
      startDate,
      endDate: startDate,
      url: link,
      source: 'dev.events',
      description: '',
    });
  }
  return events;
}

function techEventsFetchUrl(url) {
  return new Promise((resolve) => {
    const request = https.get(url, {
      signal: AbortSignal.timeout(15000),
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/calendar, application/rss+xml, application/xml, text/xml, */*',
      },
      timeout: 15000,
    }, (response) => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode) && response.headers.location) {
        return techEventsFetchUrl(response.headers.location).then(resolve);
      }
      if (response.statusCode !== 200) {
        resolve(null);
        response.resume();
        return;
      }
      let data = '';
      response.on('data', (chunk) => { data += chunk; });
      response.on('end', () => resolve(data));
      response.on('error', () => resolve(null));
    });
    request.on('error', () => resolve(null));
    request.on('timeout', () => { request.destroy(); resolve(null); });
  });
}

let techEventsSeedInFlight = false;

async function seedTechEvents() {
  if (techEventsSeedInFlight) return;
  techEventsSeedInFlight = true;
  const t0 = Date.now();
  try {
    const [icsText, rssText] = await Promise.all([
      techEventsFetchUrl(TECH_EVENTS_ICS_URL),
      techEventsFetchUrl(TECH_EVENTS_RSS_URL),
    ]);

    let events = [];
    if (icsText) {
      const parsed = techEventsParseICS(icsText);
      events.push(...parsed);
      console.log(`[TechEvents] Techmeme ICS: ${parsed.length} events`);
    } else {
      console.warn('[TechEvents] Techmeme ICS fetch failed');
    }
    if (rssText) {
      const parsed = techEventsParseRSS(rssText);
      events.push(...parsed);
      console.log(`[TechEvents] dev.events RSS: ${parsed.length} events`);
    } else {
      console.warn('[TechEvents] dev.events RSS fetch failed');
    }

    // Deduplicate by normalized title + year
    const seen = new Set();
    events = events.filter((e) => {
      const year = e.startDate.slice(0, 4);
      const key = e.title.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) + year;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Sort by date
    events.sort((a, b) => a.startDate.localeCompare(b.startDate));

    if (events.length === 0) {
      console.warn('[TechEvents] No events from any source — preserving last good data');
      return;
    }

    const payload = {
      success: true,
      count: events.length,
      conferenceCount: events.filter((e) => e.type === 'conference').length,
      mappableCount: 0, // geocoding happens in RPC handler
      lastUpdated: new Date().toISOString(),
      events,
      error: '',
    };

    const ok1 = await envelopeWrite(TECH_EVENTS_REDIS_KEY, payload, TECH_EVENTS_TTL_SECONDS, { recordCount: events.length, sourceVersion: 'tech-events' });
    const ok2 = await envelopeWrite(TECH_EVENTS_BOOTSTRAP_KEY, payload, TECH_EVENTS_TTL_SECONDS, { recordCount: events.length, sourceVersion: 'tech-events' });
    const ok3 = await upstashSet('seed-meta:research:tech-events', { fetchedAt: Date.now(), recordCount: events.length }, 604800);
    console.log(`[TechEvents] Seeded ${events.length} events (redis: ${ok1 && ok2 && ok3 ? 'OK' : 'PARTIAL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[TechEvents] Seed error:', e?.message || e);
  } finally {
    techEventsSeedInFlight = false;
  }
}

const CORRIDOR_RISK_BASE_URL = 'https://corridorrisk.io/api/corridors';

const CORRIDOR_RISK_REDIS_KEY = 'supply_chain:corridorrisk:v1';

const CORRIDOR_RISK_TTL = 14400;

let corridorRiskSeedInFlight = false;

let latestCorridorRiskData = null;

async function seedCorridorRisk() {
  if (corridorRiskSeedInFlight) { console.log('[CorridorRisk] Skipped (already in-flight)'); return; }
  corridorRiskSeedInFlight = true;
  console.log('[CorridorRisk] Fetching...');
  const t0 = Date.now();
  try {
    const resp = await fetch(CORRIDOR_RISK_BASE_URL, {
      headers: {
        Accept: 'application/json',
        'User-Agent': CHROME_UA,
        Referer: 'https://corridorrisk.io/dashboard.html',
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn(`[CorridorRisk] HTTP ${resp.status} (${resp.headers.get('content-type') || 'unknown'}) — ${body.slice(0, 200)}`);
      return;
    }
    const text = await resp.text();
    if (text.startsWith('<')) {
      console.warn(`[CorridorRisk] Got HTML instead of JSON (Cloudflare challenge?) — ${text.slice(0, 150)}`);
      return;
    }
    const corridors = JSON.parse(text);
    if (!Array.isArray(corridors) || !corridors.length) {
      console.warn('[CorridorRisk] No corridors returned — skipping');
      return;
    }
    const result = {};
    for (const corridor of corridors) {
      const name = (corridor.name || '').toLowerCase();
      const mapping = CORRIDOR_RISK_NAME_MAP.find(m => name.includes(m.pattern));
      if (!mapping) continue;
      const score = Number(corridor.score ?? 0);
      const riskLevel = deriveCorridorRiskLevel(score);
      result[mapping.id] = {
        riskLevel,
        riskScore: score,
        incidentCount7d: Number(corridor.incident_count_7d ?? 0),
        eventCount7d: Number(corridor.event_count_7d ?? 0),
        disruptionPct: Number(corridor.disruption_pct ?? 0),
        vesselCount: Number(corridor.vessel_count ?? 0),
        // Generated prose has no verified routing or cost basis.
        riskSummary: '',
        riskReportAction: '',
      };
    }
    if (Object.keys(result).length === 0) {
      console.warn('[CorridorRisk] No matching corridors — skipping');
      return;
    }
    latestCorridorRiskData = result;
    const ok = await envelopeWrite(CORRIDOR_RISK_REDIS_KEY, result, CORRIDOR_RISK_TTL, { recordCount: Object.keys(result).length, sourceVersion: 'corridor-risk' });
    await upstashSet('seed-meta:supply_chain:corridorrisk', { fetchedAt: Date.now(), recordCount: Object.keys(result).length }, 604800);
    console.log(`[CorridorRisk] Seeded ${Object.keys(result).length} corridors (redis: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    for (const [corridorId, c] of Object.entries(result)) {
      if (c.riskScore < 50) continue;
      const label = corridorId.replace(/_/g, ' ').replace(/\b\w/g, ch => ch.toUpperCase());
      publishNotificationEvent({
        eventType: 'corridor_risk',
        payload: { title: `${label}: risk score ${c.riskScore}`, source: 'Corridor Risk' },
        severity: c.riskScore >= 70 ? 'critical' : 'high',
        variant: undefined,
        dedupTtl: 3600,
      }).catch(err => console.warn('[Notify] CorridorRisk publish error:', err?.message));
    }
  } catch (e) {
    console.warn('[CorridorRisk] Seed error:', e?.message || e);
  } finally {
    corridorRiskSeedInFlight = false;
  }
}

// ─────────────────────────────────────────────────────────────
// USNI Fleet Tracker — seeded via relay (fixed IP for Froxy proxy)
// ─────────────────────────────────────────────────────────────

const USNI_URL = 'https://news.usni.org/wp-json/wp/v2/posts?categories=4137&per_page=1';

const USNI_REDIS_KEY = 'usni-fleet:sebuf:v1';

const USNI_STALE_KEY = 'usni-fleet:sebuf:stale:v1';

const USNI_TTL = 43200;

 // 12h — must outlive the 6h seed interval (2x)
const USNI_STALE_TTL = 604800;

 // 6h
const {
  usniStripHtml,
  usniParseArticle,
} = require('./lib/usni-fleet-parser.cjs');

let usniSeedInFlight = false;

async function seedUsniFleet() {
  if (usniSeedInFlight) { console.log('[USNI] Skipped (already in-flight)'); return; }
  usniSeedInFlight = true;
  console.log('[USNI] Fetching fleet tracker...');
  const t0 = Date.now();
  try {
    // USNI (WordPress): try direct fetch first (Railway Virginia should work),
    // fall back to proxy if Cloudflare blocks the datacenter IP.
    let wpData;
    let fetched = false;
    try {
      const res = await fetch(USNI_URL, {
        headers: { 'User-Agent': CHROME_UA, 'Accept': 'application/json' },
        signal: AbortSignal.timeout(15000),
      });
      if (res.ok) { wpData = await res.json(); fetched = true; }
      else { console.warn(`[USNI] Direct fetch HTTP ${res.status}, trying proxy`); }
    } catch (directErr) { console.warn(`[USNI] Direct fetch failed: ${directErr?.message}, trying proxy`); }
    if (!fetched && PROXY_URL) {
      try {
        const proxy = { ...parseProxyUrl(PROXY_URL), tls: true };
        const result = await fetchViaProxy(USNI_URL, proxy);
        if (result?.ok) {
          wpData = JSON.parse(result.body);
          fetched = true;
        } else { console.warn(`[USNI] Proxy returned HTTP ${result?.status ?? 'unavailable'}`); }
      } catch (proxyErr) { console.warn(`[USNI] Proxy error: ${proxyErr?.message}`); }
    }
    if (!fetched) throw new Error('USNI fetch failed (direct + proxy)');
    if (!Array.isArray(wpData) || !wpData.length) throw new Error('No fleet tracker articles');

    const post = wpData[0];
    const articleUrl = post.link || `https://news.usni.org/?p=${post.id}`;
    const articleDate = post.date || new Date().toISOString();
    const articleTitle = usniStripHtml(post.title?.rendered || 'USNI Fleet Tracker');
    const htmlContent = post.content?.rendered || '';
    if (!htmlContent) throw new Error('Empty article content');

    const report = usniParseArticle(htmlContent, articleUrl, articleDate, articleTitle);
    if (!report.vessels.length) { console.warn('[USNI] No vessels parsed, skipping write'); return; }

    const ok = await envelopeWrite(USNI_REDIS_KEY, report, USNI_TTL, { recordCount: report.vessels.length, sourceVersion: 'usni-fleet' });
    await envelopeWrite(USNI_STALE_KEY, report, USNI_STALE_TTL, { recordCount: report.vessels.length, sourceVersion: 'usni-fleet' });
    await upstashSet('seed-meta:military:usni-fleet', { fetchedAt: Date.now(), recordCount: report.vessels.length }, 604800);

    console.log(`[USNI] ${report.vessels.length} vessels, ${report.strikeGroups.length} CSGs, ${report.regions.length} regions (redis: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    if (report.parsingWarnings.length > 0) console.warn('[USNI] Warnings:', report.parsingWarnings.join('; '));
  } catch (e) {
    console.warn('[USNI] Seed error:', e?.message || e);
  } finally {
    usniSeedInFlight = false;
  }
}

// ─────────────────────────────────────────────────────────────
// Reddit data fetch (shared across social-velocity + WSB tickers)
// ─────────────────────────────────────────────────────────────
// Reddit's Responsible Builder Policy (2026) serves an HTML 403 to the
// unauthenticated www.reddit.com/r/<sub>/hot.json endpoint regardless of exit
// IP or User-Agent (verified 2026-06-05: residential IP, Decodo residential
// proxy, browser UA, and WM UA ALL 403 with the same HTML block page — it is a
// policy block on the endpoint, NOT an IP/UA block, so a proxy does not help)
// AND removed self-serve API-app creation, so a NEW OAuth app cannot be made.
// Both Reddit consumers route through fetchRedditHotListing(); see its own
// comment for the ScrapeCreators → OAuth → public path precedence. OAuth (usable
// only with pre-policy app creds) and the public endpoint are kept as fallbacks
// (the public path is today's no-cred default that surfaces SEED_ERROR — no
// regression when no key is set).
const REDDIT_CLIENT_ID = process.env.REDDIT_CLIENT_ID || '';

const REDDIT_CLIENT_SECRET = process.env.REDDIT_CLIENT_SECRET || '';

const REDDIT_OAUTH_ENABLED = !!(REDDIT_CLIENT_ID && REDDIT_CLIENT_SECRET);

// Reddit requires a unique, descriptive UA: "<platform>:<appid>:<version> (by
// /u/<username>)". Set REDDIT_USER_AGENT to include the developer's reddit
// username so requests are attributable per Reddit's API rules.
const REDDIT_USER_AGENT = process.env.REDDIT_USER_AGENT || 'server:app.worldmonitor:1.0 (by /u/worldmonitor)';

const REDDIT_AUTH_COOLDOWN_MS = 5 * 60 * 1000;

// ScrapeCreators — third-party Reddit data vendor (same key /last30days uses).
// PREFERRED path: it's the only one that works now that Reddit 403s the public
// .json endpoint AND removed self-serve API-app creation (Responsible Builder
// Policy 2026). Returns native Reddit fields in a flat `posts` array, so the
// downstream consumers are unchanged. When unset, the relay falls back to OAuth
// (pre-policy creds only) then the public endpoint — today's behavior, no regression.
// Sanitize: trim whitespace and strip surrounding quotes — straight AND curly
// (U+2018/U+2019/U+201C/U+201D). A smart-quote pasted into the env var makes the
// `x-api-key` header un-encodable ("Cannot convert argument to a ByteString …
// value 8221") which throws on EVERY fetch and silently disables the vendor path
// (observed in prod 2026-06-06). Stripping surrounding quotes makes the common
// paste mistake harmless; a clear warning fires if a non-Latin1 byte survives.
const SCRAPECREATORS_API_KEY = (process.env.SCRAPECREATORS_API_KEY || '')
  .trim()
  .replace(/^[\s"'‘’“”]+|[\s"'‘’“”]+$/g, '');

const SCRAPECREATORS_ENABLED = !!SCRAPECREATORS_API_KEY;

// The SC subreddit endpoint has no `limit` param — only `after` cursor pagination.
// Cap the page walk so a caller asking for `limit` posts can't run away on credits
// (≈25 posts/page → 4 pages covers WSB's limit:50 with headroom).
const SC_MAX_PAGES = 4;

let _redditToken = null;

let _redditTokenExpiry = 0;

let _redditTokenPromise = null;

let _redditAuthCooldownUntil = 0;

async function _fetchRedditToken() {
  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const resp = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': REDDIT_USER_AGENT,
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`token HTTP ${resp.status}`);
  const json = await resp.json();
  if (!json.access_token) throw new Error(`no access_token (${json.error || 'unknown'})`);
  return { token: json.access_token, expiresIn: Number(json.expires_in) || 3600 };
}

// Returns a cached userless bearer token, or null when auth is unavailable.
// Single-flight (concurrent callers share one in-flight fetch) with a 5-min
// cooldown after a failure so a broken credential doesn't hammer the auth
// endpoint every seed cycle.
async function getRedditToken() {
  const now = Date.now();
  if (_redditToken && now < _redditTokenExpiry) return _redditToken;
  if (now < _redditAuthCooldownUntil) return null;
  if (_redditTokenPromise) return _redditTokenPromise;
  _redditTokenPromise = (async () => {
    try {
      const { token, expiresIn } = await _fetchRedditToken();
      _redditToken = token;
      _redditTokenExpiry = Date.now() + Math.max(60, expiresIn - 60) * 1000; // refresh 60s early
      console.log(`[Reddit] OAuth token acquired, expires in ${expiresIn}s`);
      return token;
    } catch (e) {
      _redditToken = null;
      _redditTokenExpiry = 0;
      _redditAuthCooldownUntil = Date.now() + REDDIT_AUTH_COOLDOWN_MS;
      console.warn(`[Reddit] OAuth token fetch failed: ${e?.message || e} — cooldown ${REDDIT_AUTH_COOLDOWN_MS / 1000}s`);
      return null;
    } finally {
      _redditTokenPromise = null;
    }
  })();
  return _redditTokenPromise;
}

// Coerce a Reddit timestamp to epoch SECONDS. Native Reddit (and the Reddit
// hosts with raw_json=1) return numeric seconds (~1.7e9); a vendor could hand
// back milliseconds (~1.7e12) or an ISO string. The downstream velocity math
// (ageSec = now/1000 - created_utc) and createdAt (created_utc * 1000) both
// assume seconds, so normalize before the consumers see it.
function _redditEpochSeconds(v) {
  if (typeof v === 'number') return v > 1e12 ? Math.floor(v / 1000) : v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : n;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : undefined;
  }
  return v;
}

// The Reddit hosts pass raw_json=1, which un-escapes &amp; &lt; &gt; in text
// fields. A vendor response may still be HTML-escaped, so decode the few entities
// Reddit emits to keep panel titles identical across paths.
// &amp; must be replaced LAST: this set has no numeric refs whose output could
// re-form an entity, so amp-last decodes exactly one level (&amp;lt; stays &lt;).
function _decodeRedditEntities(s) {
  if (typeof s !== 'string') return s;
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// Normalize a ScrapeCreators post so its shape matches the OAuth/public paths
// exactly (numeric-seconds created_utc, unescaped title/selftext). Other native
// fields (score, upvote_ratio, num_comments, id, permalink, url) pass through.
function _normalizeVendorPost(p) {
  if (!p || typeof p !== 'object') return p;
  return { ...p, created_utc: _redditEpochSeconds(p.created_utc), title: _decodeRedditEntities(p.title), selftext: _decodeRedditEntities(p.selftext) };
}

// Shared "hot" listing fetch for every Reddit consumer. Returns
// { ok, status, posts, source } and never throws on an HTTP status (network/
// timeout errors still bubble to the caller's try/catch). `source` names the
// path that actually ran ('scrapecreators' | 'oauth' | 'public') so the caller's
// SEED_ERROR reason is accurate. Path precedence:
//   1. ScrapeCreators (vendor) when SCRAPECREATORS_API_KEY is set — preferred.
//   2. oauth.reddit.com when REDDIT_CLIENT_ID/SECRET are set (pre-policy app creds).
//   3. public www.reddit.com/.../hot.json (currently 403-walled; correct no-cred default).
// All paths yield the same per-post native field names (score, upvote_ratio,
// num_comments, created_utc, id, title, permalink, url), so downstream consumers
// are unchanged. ScrapeCreators returns a flat `posts` array (normalized via
// _normalizeVendorPost); the Reddit hosts return data.children[].data.
async function fetchRedditHotListing(subreddit, { limit = 25, legacyUserAgent } = {}) {
  // 1. ScrapeCreators (preferred). Cursor-paginate with `after` (the endpoint has
  // NO `limit` param) until we reach `limit` posts or run out of pages, capped at
  // SC_MAX_PAGES to bound credit spend — this preserves the old limit:50 coverage
  // for WSB even if the vendor's first page is smaller. Failure handling honors the
  // ordered-fallback contract: a page-1 HTTP failure (non-2xx) OR page-1 network/
  // timeout/parse throw logs and FALLS THROUGH to OAuth → public; a failure AFTER
  // page 1 keeps the pages already gathered. The loop degrades to first-page-only
  // if the vendor ever omits the `after` cursor.
  if (SCRAPECREATORS_ENABLED) {
    const collected = [];
    let after = '';
    let anyOk = false;
    let lastOkStatus = 0;
    try {
      for (let page = 0; page < SC_MAX_PAGES && collected.length < limit; page++) {
        const scUrl = `https://api.scrapecreators.com/v1/reddit/subreddit?subreddit=${encodeURIComponent(subreddit)}&sort=hot${after ? `&after=${encodeURIComponent(after)}` : ''}`;
        const resp = await fetch(scUrl, {
          headers: { 'x-api-key': SCRAPECREATORS_API_KEY, Accept: 'application/json' },
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) {
          if (collected.length > 0) break; // keep what we already paginated
          console.warn(`[Reddit] ScrapeCreators HTTP ${resp.status} for r/${subreddit} — falling back to OAuth/public`);
          break; // page-1 failure → fall through below
        }
        const data = await resp.json();
        anyOk = true;
        lastOkStatus = resp.status;
        const pagePosts = (Array.isArray(data?.posts) ? data.posts : []).filter(Boolean);
        collected.push(...pagePosts);
        after = typeof data?.after === 'string' ? data.after : '';
        if (!after || pagePosts.length === 0) break; // no more pages
      }
      // anyOk distinguishes "vendor responded (even with 0 posts)" from "page-1
      // failed" — only the latter falls through; a legit empty SC response returns ok.
      if (anyOk) {
        return { ok: true, status: lastOkStatus, posts: collected.slice(0, limit).map(_normalizeVendorPost), source: 'scrapecreators' };
      }
    } catch (e) {
      if (anyOk) {
        console.warn(`[Reddit] ScrapeCreators error after ${collected.length} posts for r/${subreddit}: ${e?.message || e} — using partial ScrapeCreators data`);
        return { ok: true, status: lastOkStatus, posts: collected.slice(0, limit).map(_normalizeVendorPost), source: 'scrapecreators' };
      }
      console.warn(`[Reddit] ScrapeCreators error for r/${subreddit}: ${e?.message || e} — falling back to OAuth/public`);
    }
    // fall through to OAuth → public
  }
  let url;
  let headers;
  let source;
  if (REDDIT_OAUTH_ENABLED) {
    const token = await getRedditToken();
    if (token) {
      url = `https://oauth.reddit.com/r/${subreddit}/hot?limit=${limit}&raw_json=1`;
      headers = { Authorization: `Bearer ${token}`, 'User-Agent': REDDIT_USER_AGENT, Accept: 'application/json' };
      source = 'oauth';
    }
  }
  if (!url) {
    url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}&raw_json=1`;
    headers = { Accept: 'application/json', 'User-Agent': legacyUserAgent || REDDIT_USER_AGENT };
    source = 'public';
  }
  const resp = await fetch(url, { headers, signal: AbortSignal.timeout(10000) });
  if (!resp.ok) return { ok: false, status: resp.status, posts: [], source };
  const data = await resp.json();
  return { ok: true, status: resp.status, posts: (data?.data?.children || []).map(c => c.data).filter(Boolean), source };
}

// ─────────────────────────────────────────────────────────────
// Social Velocity — Reddit r/worldnews + r/geopolitics trending
// ─────────────────────────────────────────────────────────────

const SOCIAL_VELOCITY_REDIS_KEY = 'intelligence:social:reddit:v1';

const SOCIAL_VELOCITY_SEED_META_KEY = 'seed-meta:intelligence:social-reddit';

// 3h cadence (was hourly, originally 10min). History: Reddit rate-limited the
// Railway datacenter IP under fast polling (2026-04-16: both subs 403 every cycle
// after ~50min of 10-min polling), which forced hourly. Now that fetches go via
// ScrapeCreators (not Reddit directly) the IP-rate-limit driver is gone, so the
// interval is set purely by freshness need: velocity decays over ~6h, so 3h is
// ample. See SOCIAL_VELOCITY_INTERVAL_MS / _TTL below.
const SOCIAL_VELOCITY_TTL = 43200;

 // 3h — velocity decays over ~6h; hourly was a Reddit-rate-limit leftover, not a freshness need
const REDDIT_SUBREDDITS = ['worldnews', 'geopolitics'];

let socialVelocityInFlight = false;

let socialVelocityRetryTimer = null;

const SOCIAL_VELOCITY_RETRY_MS = 20 * 60 * 1000;

function socialVelocityMetaErrorReason(reason) {
  return String(reason || 'unknown').replace(/\s+/g, ' ').slice(0, 240);
}

async function writeSocialVelocityFailureMeta(reason) {
  return upstashSet(SOCIAL_VELOCITY_SEED_META_KEY, {
    fetchedAt: Date.now(),
    recordCount: 0,
    sourceVersion: 'social-reddit',
    status: 'error',
    errorReason: socialVelocityMetaErrorReason(reason),
  }, 604800);
}

async function writeSocialVelocityHealthyMeta(recordCount) {
  try {
    const ok = await upstashSet(SOCIAL_VELOCITY_SEED_META_KEY, {
      fetchedAt: Date.now(),
      recordCount,
      sourceVersion: 'social-reddit',
      status: 'ok',
    }, 604800);
    if (!ok) {
      console.warn('[SocialVelocity] Healthy seed-meta write failed; preserving canonical payload state');
    }
    return ok;
  } catch (e) {
    console.warn('[SocialVelocity] Healthy seed-meta write threw:', e?.message || e);
    return false;
  }
}

async function fetchRedditHot(subreddit, failures = []) {
  const { ok, status, posts, source } = await fetchRedditHotListing(subreddit, {
    limit: 25,
    legacyUserAgent: 'WorldMonitor/1.0 (contact: info@worldmonitor.app)',
  });
  if (!ok) {
    const failure = `r/${subreddit} HTTP ${status} (${source})`;
    failures.push(failure);
    console.warn(`[SocialVelocity] Reddit ${failure}`);
    return [];
  }
  return posts;
}

async function seedSocialVelocity() {
  if (socialVelocityInFlight) { console.log('[SocialVelocity] Skipped (in-flight)'); return; }
  socialVelocityInFlight = true;
  if (socialVelocityRetryTimer) { clearTimeout(socialVelocityRetryTimer); socialVelocityRetryTimer = null; }
  console.log('[SocialVelocity] Fetching...');
  const t0 = Date.now();
  try {
    const nowSec = Date.now() / 1000;
    const allPosts = [];
    const seenUrls = new Set();
    const fetchFailures = [];
    for (const sub of REDDIT_SUBREDDITS) {
      await new Promise(r => setTimeout(r, 500));
      const posts = await fetchRedditHot(sub, fetchFailures);
      for (const p of posts) {
        if (!p || typeof p.permalink !== 'string' || !p.permalink.startsWith('/r/')) continue;
        let postUrl;
        try {
          postUrl = new URL(p.permalink, 'https://reddit.com');
          if (postUrl.origin !== 'https://reddit.com'
            || !/^\/r\/[A-Za-z0-9_]+\/comments\/[A-Za-z0-9]+(?:\/|$)/.test(postUrl.pathname)
            || postUrl.href.length > 2048) continue;
        } catch { continue; }
        // Deduplicate cross-subreddit reposts of the same article URL.
        const articleUrl = p.url || '';
        let articleHostname = '';
        try { articleHostname = new URL(articleUrl).hostname; } catch { /* invalid URLs are not deduplicated */ }
        const isExternal = articleHostname && articleHostname !== 'reddit.com' && !articleHostname.endsWith('.reddit.com');
        if (isExternal && seenUrls.has(articleUrl)) continue;
        if (isExternal) seenUrls.add(articleUrl);
        const ageSec = Math.max(1, nowSec - (p.created_utc || nowSec));
        const recencyFactor = Math.exp(-ageSec / (6 * 3600));
        const velocityScore = Math.log1p(p.score || 1) * (p.upvote_ratio || 0.5) * recencyFactor * 100;
        allPosts.push({
          id: String(p.id || ''),
          title: String(p.title || '').slice(0, 300),
          subreddit: sub,
          url: postUrl.href,
          score: p.score || 0,
          upvoteRatio: p.upvote_ratio || 0,
          numComments: p.num_comments || 0,
          velocityScore: Math.round(velocityScore * 10) / 10,
          createdAt: Math.round((p.created_utc || nowSec) * 1000),
        });
      }
    }
    if (!allPosts.length) {
      console.warn('[SocialVelocity] No posts — extending TTL, retrying in 20min');
      try { await upstashExpire(SOCIAL_VELOCITY_REDIS_KEY, SOCIAL_VELOCITY_TTL); } catch {}
      try {
        const reason = fetchFailures.length
          ? `empty_reddit_response: ${fetchFailures.join('; ')}`
          : 'empty_reddit_response';
        await writeSocialVelocityFailureMeta(reason);
      } catch {}

      return;
    }
    allPosts.sort((a, b) => b.velocityScore - a.velocityScore);
    const top = allPosts.slice(0, 30);
    const payload = { posts: top, fetchedAt: Date.now() };
    const ok = await envelopeWrite(SOCIAL_VELOCITY_REDIS_KEY, payload, SOCIAL_VELOCITY_TTL, { recordCount: top.length, sourceVersion: 'social-reddit' });
    if (ok) {
      await writeSocialVelocityHealthyMeta(top.length);
    } else {
      console.error('[SocialVelocity] Canonical write failed. Marking seed-meta error.');
      try { await writeSocialVelocityFailureMeta('canonical_write_failed'); } catch {}
    }
    console.log(`[SocialVelocity] Seeded ${top.length} posts (redis: ${ok ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[SocialVelocity] Seed error:', e?.message || e, '— extending TTL, retrying in 20min');
    try { await upstashExpire(SOCIAL_VELOCITY_REDIS_KEY, SOCIAL_VELOCITY_TTL); } catch {}
    try { await writeSocialVelocityFailureMeta(`seed_error: ${e?.message || e}`); } catch {}

  } finally {
    socialVelocityInFlight = false;
  }
}

// ─────────────────────────────────────────────────────────────
// WSB Ticker Scanner — Reddit r/wallstreetbets + r/stocks + r/investing
// ─────────────────────────────────────────────────────────────

const WSB_TICKERS_REDIS_KEY = 'intelligence:wsb-tickers:v1';

// 3h cadence — same history + ScrapeCreators rationale as SocialVelocity above.
const WSB_TICKERS_TTL = 43200;

 // 3h — same cadence rationale as SocialVelocity above
const WSB_TICKERS_RETRY_MS = 20 * 60 * 1000;

const WSB_SUBREDDITS = ['wallstreetbets', 'stocks', 'investing'];

// $-prefixed: case-insensitive ($nvda, $NVDA, $BRK.B). Bare: uppercase only (NVDA, BRK.B).
// $-prefixed tickers skip whitelist validation (strong signal). Bare uppercase validated against known set.
const DOLLAR_TICKER_REGEX = /\$([a-zA-Z]{1,5}(?:[.-][a-zA-Z]{1,2})?)\b/g;

const BARE_TICKER_REGEX = /\b([A-Z]{1,5}(?:[.-][A-Z]{1,2})?)\b/g;

const TICKER_BLACKLIST = new Set([
  'I','A','ALL','FOR','THE','CEO','GDP','IPO','SEC','FDA','IMF','ETF','ATH',
  'DD','YOLO','FOMO','FUD','HODL','WSB','USA','EU','UK','AI','EV','IT','OR',
  'AM','PM','ON','BE','SO','GO','AT','TO','UP','NO','IF','AS','BY','AN','DO',
  'IN','OF','IS','HAS','NEW','CFO','CTO','IRS','FBI','CIA','UN','WHO',
  'IMO','PSA','FYI','TL','DR','OP','OC','US','ER','RE','VS',
]);

let wsbTickersInFlight = false;

let wsbTickersRetryTimer = null;

let wsbTickerSetCache = null;

let wsbTickerSetCacheTs = 0;

const WSB_TICKER_SET_CACHE_TTL_MS = 30 * 60 * 1000;

 // refresh known ticker set every 30min

async function loadWsbTickerSet() {
  if (wsbTickerSetCache && (Date.now() - wsbTickerSetCacheTs < WSB_TICKER_SET_CACHE_TTL_MS)) return wsbTickerSetCache;
  try {
    const data = await envelopeRead('market:stocks-bootstrap:v1');
    if (data && Array.isArray(data.quotes)) {
      wsbTickerSetCache = new Set(data.quotes.map(s => s.symbol?.toUpperCase()).filter(Boolean));
      wsbTickerSetCacheTs = Date.now();
      return wsbTickerSetCache;
    }
  } catch {}
  return wsbTickerSetCache || new Set();
}

async function fetchWsbRedditHot(subreddit) {
  const { ok, status, posts, source } = await fetchRedditHotListing(subreddit, { limit: 50, legacyUserAgent: CHROME_UA });
  if (!ok) { console.warn(`[WsbTickers] Reddit r/${subreddit} HTTP ${status} (${source})`); return []; }
  return posts;
}

function normalizeTicker(raw) {
  // BRK.B → BRK-B (Yahoo Finance uses dash, Reddit uses dot)
  return raw.toUpperCase().replace(/\./g, '-');
}

function extractTickers(text, knownTickers) {
  const found = new Set();
  if (!text) return found;
  let m;

  // $-prefixed tickers: strong signal, skip whitelist validation (only blacklist)
  DOLLAR_TICKER_REGEX.lastIndex = 0;
  while ((m = DOLLAR_TICKER_REGEX.exec(text)) !== null) {
    const sym = normalizeTicker(m[1] || '');
    if (!sym || sym.length < 1) continue;
    if (TICKER_BLACKLIST.has(sym)) continue;
    found.add(sym);
  }

  // Bare uppercase: high false-positive risk, REQUIRE known ticker set
  // When knownTickers is empty (bootstrap unavailable), skip bare matching entirely
  if (knownTickers.size > 0) {
    BARE_TICKER_REGEX.lastIndex = 0;
    while ((m = BARE_TICKER_REGEX.exec(text)) !== null) {
      const sym = normalizeTicker(m[1] || '');
      if (!sym || sym.length < 1) continue;
      if (TICKER_BLACKLIST.has(sym)) continue;
      if (!knownTickers.has(sym)) continue;
      found.add(sym);
    }
  }

  return found;
}

async function seedWsbTickers() {
  if (wsbTickersInFlight) { console.log('[WsbTickers] Skipped (in-flight)'); return; }
  wsbTickersInFlight = true;
  if (wsbTickersRetryTimer) { clearTimeout(wsbTickersRetryTimer); wsbTickersRetryTimer = null; }
  console.log('[WsbTickers] Fetching...');
  const t0 = Date.now();
  try {
    const knownTickers = await loadWsbTickerSet();
    if (knownTickers.size === 0) {
      console.warn('[WsbTickers] Known ticker set empty (bootstrap unavailable). $-prefixed tickers will still be extracted; bare uppercase validation disabled.');
    }
    const nowSec = Date.now() / 1000;
    const tickerMap = new Map();
    let postsScanned = 0;

    for (const sub of WSB_SUBREDDITS) {
      await new Promise(r => setTimeout(r, 500));
      const posts = await fetchWsbRedditHot(sub);
      for (const p of posts) {
        postsScanned++;
        const text = `${p.title || ''} ${p.selftext || ''}`;
        const tickers = extractTickers(text, knownTickers);
        for (const sym of tickers) {
          let entry = tickerMap.get(sym);
          if (!entry) {
            entry = {
              symbol: sym,
              mentionCount: 0,
              postIds: new Set(),
              totalScore: 0,
              upvoteRatioSum: 0,
              topPost: null,
              subreddits: new Set(),
            };
            tickerMap.set(sym, entry);
          }
          entry.mentionCount++;
          entry.postIds.add(p.id);
          entry.totalScore += (p.score || 0);
          entry.upvoteRatioSum += (p.upvote_ratio || 0);
          entry.subreddits.add(sub);
          if (!entry.topPost || (p.score || 0) > entry.topPost.score) {
            entry.topPost = {
              title: String(p.title || '').slice(0, 300),
              url: `https://reddit.com${p.permalink || ''}`,
              score: p.score || 0,
              subreddit: sub,
            };
          }
        }
      }
    }

    if (tickerMap.size === 0) {
      console.warn('[WsbTickers] No tickers found — extending TTL, retrying in 20min');
      try { await upstashExpire(WSB_TICKERS_REDIS_KEY, WSB_TICKERS_TTL); } catch {}

      return;
    }

    const tickers = [];
    for (const [, entry] of tickerMap) {
      const uniquePosts = entry.postIds.size;
      const avgUpvoteRatio = uniquePosts > 0 ? Math.round((entry.upvoteRatioSum / uniquePosts) * 100) / 100 : 0;
      const ageFactor = 1; // all posts are "hot" (recent)
      const velocityScore = Math.round(Math.log1p(entry.totalScore) * entry.mentionCount * ageFactor * 10) / 10;
      tickers.push({
        symbol: entry.symbol,
        mentionCount: entry.mentionCount,
        uniquePosts,
        totalScore: entry.totalScore,
        avgUpvoteRatio,
        topPost: entry.topPost,
        subreddits: [...entry.subreddits],
        velocityScore,
      });
    }

    tickers.sort((a, b) => b.velocityScore - a.velocityScore);
    const top = tickers.slice(0, 50);
    const payload = { tickers: top, fetchedAt: Date.now(), subredditsScanned: WSB_SUBREDDITS.length, postsScanned };
    const writeOk = await envelopeWrite(WSB_TICKERS_REDIS_KEY, payload, WSB_TICKERS_TTL, { recordCount: top.length, sourceVersion: 'wsb-tickers' });
    if (writeOk) {
      await upstashSet('seed-meta:intelligence:wsb-tickers', { fetchedAt: Date.now(), recordCount: top.length }, 604800);
    } else {
      console.error('[WsbTickers] Canonical write failed. Skipping seed-meta.');
    }
    console.log(`[WsbTickers] Seeded ${top.length} tickers from ${postsScanned} posts (redis: ${writeOk ? 'OK' : 'FAIL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[WsbTickers] Seed error:', e?.message || e, '— extending TTL, retrying in 20min');
    try { await upstashExpire(WSB_TICKERS_REDIS_KEY, WSB_TICKERS_TTL); } catch {}

  } finally {
    wsbTickersInFlight = false;
  }
}

// PizzINT Seed — Pentagon Pizza Index + GDELT tensions → Redis
// Fetches from pizzint.watch on Railway (datacenter IPs blocked
// from Vercel Edge). Vercel handler reads from seed key only.
// ─────────────────────────────────────────────────────────────
// 15 min is the BestTime paid-plan budget: 96 polls/day per venue.
const PIZZINT_SEED_INTERVAL_MS = 15 * 60 * 1000;

const PIZZINT_SEED_TTL = 2700;

 // 45 min (3× interval)
const PIZZINT_SEED_META_KEY = 'seed-meta:intelligence:pizzint';

// Venues that answer cleanly without a live reading (closed, or not reporting
// yet) keep the heartbeat fresh, but only this long after the last live
// reading, so a venue that never comes back still surfaces as stale.
const PIZZINT_QUIET_MAX_MS = 24 * 60 * 60 * 1000;

const PIZZINT_REDIS_KEY = 'intelligence:pizzint:seed:v1';

const PIZZINT_API = 'https://www.pizzint.watch/api/dashboard-data';

// Fallback feed while PizzINT itself is down: BestTime live busyness for the
// Pentagon-area venues PizzINT tracks. Registered 2026-09-27 via BestTime's
// forecast endpoint; Papa Johns (2440 Wilson Blvd) on 2026-09-28, the branch
// PizzINT tracks (3400 Columbia Pike was a wrong address). Domino's
// (3535 S Ball St) has too little visitor volume to forecast; its id came from
// a live lookup by name and address on 2026-09-28, so it is liveOnly: no
// baseline, and without a forecast BestTime has no opening hours for it (the
// Columbia Pike branch reported Closed at lunchtime).
const PIZZINT_BESTTIME_LIVE_API = 'https://besttime.app/api/v1/forecasts/live';

const PIZZINT_BESTTIME_TIMEOUT_MS = 30_000;

const PIZZINT_BESTTIME_VENUES = [
  { venueId: 'ven_636a594762457274396434526b347433654365726959634a496843', name: 'Extreme Pizza', lat: 38.8602396, lng: -77.0559854 },
  { venueId: 'ven_41336f327a61637672416e526b34743375584c655132344a496843', name: 'District Pizza Palace', lat: 38.8527414, lng: -77.0531408 },
  { venueId: 'ven_636b324a746c7a45666534526b347432794e41455465374a496843', name: 'Nighthawk Brewery & Pizza', lat: 38.8631637, lng: -77.0624806 },
  { venueId: 'ven_67314d44325f7774795356526b3474336d515f6e6962724a496843', name: 'Pizzato Pizza', lat: 38.8806865, lng: -77.089827 },
  { venueId: 'ven_4d2d7454795a336a723962526b3474784b54634d7352694a496843', name: "Domino's Pizza", lat: 38.8430908, lng: -77.0507832, liveOnly: true },
  { venueId: 'ven_493038537a313933526546526b347432696f537a5538694a496843', name: 'Papa Johns Pizza', lat: 38.8903112, lng: -77.0883773 },
];

let pizzintSeedInFlight = false;

// World Monitor index, identical for both providers; provider DEFCON is ignored.
// A candidate needs >=150% of hourly usual AND >=25 busyness points of excess.
// Require three consecutive fresh, distinct observations: each gap must be
// 0.9–1.5× the polling interval, so 1.8× elapsed means at least three readings.
// Missing/closed/stale readings or a provider change reset it.
// Each sustained venue contributes min(25, excess percent / 5) index points.
// Sum thresholds 25/50/70/85 map to DEFCON 4/3/2/1; otherwise DEFCON 5.
// See docs/algorithms.mdx. This is a venue-activity index, not military readiness.
function scorePizzintLocations(locations, previous, now) {
  const gap = now - (previous?.updatedAt || 0);
  const priorLocations = Array.isArray(previous?.locations) ? previous.locations : [];
  let score = 0;
  for (const location of locations) {
    const live = location.currentPopularity;
    const forecast = location.forecastPopularity;
    location.hasBaseline = Number.isFinite(forecast) && forecast > 0;
    location.noLiveSignal = !Number.isFinite(live) || live < 0
      || (!location.isClosedNow && live === 0 && (forecast >= 20 || !(forecast > 0)));
    const delta = location.hasBaseline ? Math.max(0, live - forecast) : 0;
    const observedAt = Date.parse(location.recordedAt);
    const candidate = !location.isClosedNow && !location.noLiveSignal
      && location.dataFreshness === 'DATA_FRESHNESS_FRESH'
      && Number.isFinite(observedAt) && observedAt <= now && now - observedAt <= PIZZINT_SEED_INTERVAL_MS
      && location.percentageOfUsual >= 150 && delta >= 25;
    const prior = priorLocations.find(l => l.placeId === location.placeId && l.dataSource === location.dataSource);
    const continues = candidate && gap >= 0.9 * PIZZINT_SEED_INTERVAL_MS && gap <= 1.5 * PIZZINT_SEED_INTERVAL_MS
      && prior?.anomalyStartedAt > 0 && prior.anomalyStartedAt <= previous.updatedAt
      && observedAt > Date.parse(prior.recordedAt);
    // Internal cache fields survive relay restarts. Old payloads have no start
    // time and start afresh.
    location.anomalyStartedAt = candidate ? (continues ? prior.anomalyStartedAt : now) : 0;
    location.isSpike = candidate && now - location.anomalyStartedAt >= 1.8 * PIZZINT_SEED_INTERVAL_MS;
    location.spikeMagnitude = location.isSpike ? delta : 0;
    if (location.isSpike) score += Math.min(25, (location.percentageOfUsual - 100) / 5);
  }
  return Math.min(100, score);
}

function pizzintLocationFromBestTime(venue, reply) {
  const analysis = reply?.analysis || {};
  const info = reply?.venue_info || {};
  const live = analysis.venue_live_busyness;
  if (analysis.venue_live_busyness_available !== true || typeof live !== 'number' || !Number.isFinite(live)) return null;
  const forecast = analysis.venue_forecasted_busyness;
  // A live-only venue never takes a baseline, even if BestTime starts sending one.
  const hasForecast = !venue.liveOnly && analysis.venue_forecast_busyness_available === true
    && typeof forecast === 'number' && Number.isFinite(forecast) && forecast > 0;
  return {
    placeId: venue.venueId,
    name: venue.name,
    address: typeof info.venue_address === 'string' ? info.venue_address : '',
    currentPopularity: live,
    percentageOfUsual: hasForecast ? Math.round((live / forecast) * 100) : 0,
    forecastPopularity: hasForecast ? forecast : 0,
    dataSource: 'besttime',
    recordedAt: new Date(Date.now()).toISOString(),
    dataFreshness: 'DATA_FRESHNESS_FRESH',
    isClosedNow: pizzintBestTimeClosed(venue, reply),
    lat: venue.lat,
    lng: venue.lng,
  };
}

function pizzintBestTimeClosed(venue, reply) {
  return !venue.liveOnly && reply?.venue_info?.venue_open === 'Closed';
}

// One venue's outcome. Never throws; every failure is a fixed category.
async function pollPizzintBestTimeVenue(apiKey, venue) {
  const url = `${PIZZINT_BESTTIME_LIVE_API}?api_key_private=${encodeURIComponent(apiKey)}&venue_id=${encodeURIComponent(venue.venueId)}`;
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(PIZZINT_BESTTIME_TIMEOUT_MS),
    });
    if (!resp.ok) {
      try { await resp.body?.cancel(); } catch { /* Keep the HTTP outcome if cleanup fails. */ }
      // The status is the only diagnostic worth keeping: a 400/401 means the
      // key is wrong, a 429 means the plan budget is spent, a 5xx is BestTime
      // itself. The body is dropped unread (it can echo the key).
      return { outcome: 'http', status: resp.status };
    }
    let reply;
    try {
      reply = await resp.json();
    } catch (error) {
      return { outcome: error?.name === 'SyntaxError' ? 'json' : error?.name === 'TimeoutError' ? 'timeout' : 'transport' };
    }
    const location = pizzintLocationFromBestTime(venue, reply);
    if (location) return { outcome: 'accepted', location, reply };
    return { outcome: reply?.analysis?.venue_live_busyness_available === false ? 'unavailable' : 'invalid', reply };
  } catch (error) {
    return { outcome: error?.name === 'TimeoutError' ? 'timeout' : 'transport' };
  }
}

// A registered venue without a live reading this poll. Zero live and zero
// forecast make the scorer mark it noLiveSignal (shown as NO DATA) unless the
// provider reported it closed.
function pizzintBestTimePlaceholder(venue, reply) {
  return {
    placeId: venue.venueId,
    name: venue.name,
    address: typeof reply?.venue_info?.venue_address === 'string' ? reply.venue_info.venue_address : '',
    currentPopularity: 0,
    percentageOfUsual: 0,
    forecastPopularity: 0,
    dataSource: 'besttime',
    recordedAt: '',
    dataFreshness: 'DATA_FRESHNESS_STALE',
    isClosedNow: pizzintBestTimeClosed(venue, reply),
    lat: venue.lat,
    lng: venue.lng,
  };
}

// The private key travels only in the request URL, which is never logged.
// locations: venues with a live reading. published: every registered venue in
// registry order, with placeholders for the rest (the same objects, so scoring
// one scores both).
async function fetchPizzintBestTimeLocations(apiKey) {
  const polls = await Promise.all(PIZZINT_BESTTIME_VENUES.map(venue => pollPizzintBestTimeVenue(apiKey, venue)));
  const counts = { accepted: 0, unavailable: 0, invalid: 0, http: 0, timeout: 0, transport: 0, json: 0 };
  const httpStatuses = new Map();
  const locations = [];
  const published = [];
  const historyLocations = [];
  PIZZINT_BESTTIME_VENUES.forEach((venue, i) => {
    const { outcome, location, reply, status } = polls[i];
    counts[outcome]++;
    if (outcome === 'http') httpStatuses.set(status, (httpStatuses.get(status) || 0) + 1);
    if (location) {
      locations.push(location);
      published.push(location);
      historyLocations.push(location);
      return;
    }
    published.push(pizzintBestTimePlaceholder(venue, reply));
    if (!reply) return;
    historyLocations.push({
      placeId: venue.venueId,
      currentPopularity: null,
      forecastPopularity: reply?.analysis?.venue_forecast_busyness_available === true && Number.isFinite(reply?.analysis?.venue_forecasted_busyness) ? reply.analysis.venue_forecasted_busyness : null,
      dataSource: 'besttime',
      recordedAt: '',
      dataFreshness: 'DATA_FRESHNESS_FRESH',
      isClosedNow: pizzintBestTimeClosed(venue, reply),
      noLiveSignal: true,
    });
  });
  // http=3 alone cannot tell a bad key (400/401) from a spent plan budget
  // (429) or a BestTime outage (5xx); the status histogram can.
  const summary = Object.entries(counts).map(([category, count]) => (
    category === 'http' && count > 0
      ? `http=${count}(${[...httpStatuses].sort(([a], [b]) => a - b).map(([code, n]) => `${code}x${n}`).join(',')})`
      : `${category}=${count}`
  )).join(' ');
  // Every venue answered cleanly; with no accepted reading, all reported unavailable.
  const answered = counts.accepted + counts.unavailable === PIZZINT_BESTTIME_VENUES.length;
  if (locations.length === 0) {
    console.warn(`[PizzINT] BestTime fallback: no live readings (0/${PIZZINT_BESTTIME_VENUES.length} venues); ${summary}; preserving last good observation`);
    return historyLocations.length ? { locations, published, historyLocations, answered } : null;
  }
  console.log(`[PizzINT] BestTime fallback: ${locations.length}/${PIZZINT_BESTTIME_VENUES.length} venues live; ${summary}`);
  return { locations, published, historyLocations, answered };
}

function pizzintLastLiveAt(meta) {
  if (meta && 'lastLiveAt' in meta) return Number(meta.lastLiveAt) || 0;
  // Metadata written before lastLiveAt existed: its fetchedAt was a live publish.
  return meta?.recordCount > 0 ? Number(meta.fetchedAt) || 0 : 0;
}

// A clean poll with no usable live reading is quiet hours, not an outage: advance the
// heartbeat without touching the live payload. api/health.js lists pizzint in
// EMPTY_DATA_OK_KEYS, so the expired payload then reads OK while this runs, and
// STALE_SEED once it stops (provider errors, a dead loop, or 24h without a live
// reading).
// Also used for a publication without a live signal. Returns false only when the
// write itself fails; a heartbeat withheld by the cap is not a failure.
async function recordPizzintQuietPoll(recordCount = 0) {
  const lastLiveAt = pizzintLastLiveAt(await upstashGet(PIZZINT_SEED_META_KEY));
  const now = Date.now();
  if (!lastLiveAt || now - lastLiveAt >= PIZZINT_QUIET_MAX_MS) return true;
  return upstashSet(PIZZINT_SEED_META_KEY, { fetchedAt: now, recordCount, lastLiveAt }, 604800);
}

async function seedPizzint() {
  if (pizzintSeedInFlight) return;
  pizzintSeedInFlight = true;
  const t0 = Date.now();
  let archive;
  try {
    let raw = null;
    try {
      const resp = await fetch(PIZZINT_API, {
        headers: { Accept: 'application/json', 'User-Agent': CHROME_UA },
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) {
        console.warn(`[PizzINT] Seed failed: HTTP ${resp.status}`);
      } else {
        raw = await resp.json();
        if (!raw.success || !Array.isArray(raw.data) || raw.data.length === 0) {
          const reason = !raw.success ? 'unsuccessful_response'
            : !Array.isArray(raw.data) ? 'non_array_data' : 'empty_array';
          console.warn(`[PizzINT] No data in API response (${reason}); preserving last good observation`);
          raw = null;
        }
      }
    } catch (e) {
      console.warn(`[PizzINT] Seed failed: ${e?.name || 'Error'}`);
      raw = null;
    }
    // Stale numbers and open zero/zero rows cannot supply a usable primary signal.
    // Keep fresh closed zeros valid, as in the existing scorer/publication contract.
    const hasPrimaryReading = raw?.data.some(d => d.data_freshness === 'fresh'
      && Number.isFinite(d.current_popularity) && d.current_popularity >= 0
      && (d.current_popularity > 0 || d.is_closed_now));
    const besttimeKey = hasPrimaryReading ? '' : (process.env.BESTTIME_API_KEY_PRIVATE || '');
    const fallback = besttimeKey ? await fetchPizzintBestTimeLocations(besttimeKey) : null;
    if (!raw && !fallback) return;

    const locations = fallback?.locations || raw.data.map((d) => ({
      placeId: d.place_id || '',
      name: d.name || '',
      address: d.address || '',
      currentPopularity: typeof d.current_popularity === 'number' ? d.current_popularity : 0,
      percentageOfUsual: typeof d.percentage_of_usual === 'number' ? d.percentage_of_usual : 0,
      // Recover the hourly baseline from PizzINT's published ratio. A zero
      // ratio cannot identify a baseline; keep it unknown rather than invent one.
      forecastPopularity: Number.isFinite(d.percentage_of_usual) && d.percentage_of_usual > 0
        && Number.isFinite(d.current_popularity) && d.current_popularity > 0
        ? d.current_popularity * 100 / d.percentage_of_usual : 0,
      dataSource: d.data_source || '',
      recordedAt: d.recorded_at || '',
      dataFreshness: d.data_freshness === 'fresh' ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
      isClosedNow: !!d.is_closed_now,
      ...(pizzintVenuePoint(d) ?? { lat: 0, lng: 0 }),
    }));

    const previous = await envelopeRead(PIZZINT_REDIS_KEY);
    // Every registered venue is published; only live readings decide whether to publish.
    const published = fallback?.published || locations;
    const adjusted = scorePizzintLocations(published, previous?.pizzint, Date.now());
    archive = recordPizzintHistory({
      provider: fallback ? 'besttime' : 'pizzint',
      locations: fallback?.historyLocations || locations,
      capturedAt: new Date(Date.now()).toISOString(),
    }, upstashEval).catch((e) => {
      // A FIXED vocabulary, never the raw message: upstream error text can carry
      // the request URL and its embedded credential, which is why the publication
      // suite throws 'secret archive failure' and asserts it never reaches a log.
      // The category still tells an operator whether the next poll can recover --
      // bounds and validation repeat forever (a 25th upstream venue tripping
      // MAX_LOCATIONS, say), write_rejected may be a one-off. Compared by name
      // rather than instanceof so it survives a cross-realm error.
      const category = e?.name === 'RangeError' ? 'bounds'
        : e?.name === 'TypeError' ? 'validation'
        : e?.message === 'history_write_failed' ? 'write_rejected' : 'unknown';
      console.warn('[PizzINT] History archive failed:', category);
    });
    if (locations.every(l => l.noLiveSignal)) {
      if (locations.length > 0) console.warn('[PizzINT] No live signals; preserving last good observation');
      // The provider still answered every venue cleanly (e.g. a closing venue
      // reading 0), so the source is healthy; the 24h lastLiveAt cap catches dead sensors.
      if ((!fallback || fallback.answered) && await recordPizzintQuietPoll()) return 'quiet';
      return;
    }
    const openLocations = published.filter((l) => !l.isClosedNow && !l.noLiveSignal);
    const activeSpikes = published.filter((l) => l.isSpike).length;
    const avgPop = openLocations.length > 0
      ? openLocations.reduce((s, l) => s + l.currentPopularity, 0) / openLocations.length
      : 0;

    let defconLevel = 5;
    let defconLabel = 'Normal Activity';
    if (adjusted >= 85) { defconLevel = 1; defconLabel = 'Maximum Activity'; }
    else if (adjusted >= 70) { defconLevel = 2; defconLabel = 'High Activity'; }
    else if (adjusted >= 50) { defconLevel = 3; defconLabel = 'Elevated Activity'; }
    else if (adjusted >= 25) { defconLevel = 4; defconLabel = 'Above Normal'; }

    const hasFresh = locations.some((l) => l.dataFreshness === 'DATA_FRESHNESS_FRESH');

    const pizzint = {
      defconLevel,
      defconLabel,
      aggregateActivity: Math.round(avgPop),
      activeSpikes,
      locationsMonitored: published.length,
      locationsOpen: openLocations.length,
      updatedAt: Date.now(),
      dataFreshness: hasFresh ? 'DATA_FRESHNESS_FRESH' : 'DATA_FRESHNESS_STALE',
      locations: published,
    };

    const payload = { pizzint, tensionPairs: [] };
    const ok1 = await envelopeWrite(PIZZINT_REDIS_KEY, payload, PIZZINT_SEED_TTL, { recordCount: locations.length, sourceVersion: fallback ? 'besttime-live' : 'pizzint' });
    // Only an open venue's fresh reading is live. A publication of closed zeros or
    // stale readings carries lastLiveAt and takes the capped quiet heartbeat, and
    // from BestTime only when every venue answered cleanly.
    const hasLiveSignal = published.some((l) => !l.noLiveSignal && !l.isClosedNow && l.dataFreshness === 'DATA_FRESHNESS_FRESH');
    const ok2 = ok1 && (hasLiveSignal
      ? await upstashSet(PIZZINT_SEED_META_KEY, { fetchedAt: Date.now(), recordCount: locations.length, lastLiveAt: Date.now() }, 604800)
      : !fallback || fallback.answered ? await recordPizzintQuietPoll(locations.length) : true);
    console.log(`[PizzINT] Seeded ${locations.length} locations (open:${openLocations.length} spikes:${activeSpikes} defcon:${defconLevel} redis:${ok1 && ok2 ? 'OK' : 'PARTIAL'}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } catch (e) {
    console.warn('[PizzINT] Seed error:', e?.message || e);
  } finally {
    await archive;
    pizzintSeedInFlight = false;
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

function recordNotificationDedupSetNxError({ line, action }) {
  incrementRelayMetric('notificationDedupSetNxErrors');
  incrementRelayMetric(action === 'fail_open' ? 'notificationDedupSetNxFailOpen' : 'notificationDedupSetNxFailClosed');
  console.warn(line);
}

const vessels = new Map();

// ── Proxy fetch helper ─────────────────────────────────────────────
// Resolves { ok, status, body } and never rejects. Written for the retired YouTube live
// detection; the relay's PROXY_URL callers (Yahoo chart, USNI and others) still use it.
function fetchViaProxy(targetUrl, proxy) {
  const { proxyFetch } = require('./_proxy-utils.cjs');
  return proxyFetch(targetUrl, proxy, { headers: { 'User-Agent': CHROME_UA } })
    .then(r => ({ ok: r.ok, status: r.status, body: r.buffer.toString('utf8') }))
    .catch(() => ({ ok: false, status: 0, body: '' }));
}

return {seedSectorSummary,seedSatelliteTLEs,seedTechEvents,seedCorridorRisk,seedUsniFleet,seedSocialVelocity,seedWsbTickers,seedGscpi,seedPizzint};
};
