const http = require('node:http');
const https = require('node:https');
const { proxyFetch } = require('./_proxy-utils.cjs');

const CHROME_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

// Read the store settings at construction, after the personal runtime has configured them.
function createPersonalRedisClient() {
  const UPSTASH_REDIS_REST_URL = process.env.UPSTASH_REDIS_REST_URL || '';
  const UPSTASH_REDIS_REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || '';
  const UPSTASH_ENABLED = !!(UPSTASH_REDIS_REST_URL && UPSTASH_REDIS_REST_TOKEN);
  const UPSTASH_HTTP_MODULE = UPSTASH_REDIS_REST_URL.startsWith('http://') ? http : https;

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

  // Use the canonical seed envelope shape shared with server and API readers.
  function buildEnvelope({ fetchedAt, recordCount, sourceVersion, schemaVersion, state, failedDatasets, errorReason, groupId, data }) {
    const _seed = { fetchedAt, recordCount, sourceVersion, schemaVersion, state };
    if (failedDatasets != null) _seed.failedDatasets = failedDatasets;
    if (errorReason != null) _seed.errorReason = errorReason;
    if (groupId != null) _seed.groupId = groupId;
    return { _seed, data };
  }

  // Publish the envelope with the same metadata defaults as the existing seeds.
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

  // Accept both enveloped and legacy bare values.
  async function envelopeRead(key, onFailure) {
    const raw = await upstashGet(key, onFailure);
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && '_seed' in raw && 'data' in raw) {
      return raw.data;
    }
    return raw;
  }

  return { UPSTASH_ENABLED, upstashGet, upstashSet, upstashExpire, upstashEval, envelopeWrite, envelopeRead };
}

function createThrottledLogger(logThrottleState = new Map()) {
  const RELAY_LOG_THROTTLE_MS = Math.max(1000, Number(process.env.RELAY_LOG_THROTTLE_MS || 10000));

  return function logThrottled(level, key, ...args) {
    const now = Date.now();
    const last = logThrottleState.get(key) || 0;
    if (now - last < RELAY_LOG_THROTTLE_MS) return;
    logThrottleState.set(key, now);
    console[level](...args);
  };
}

// Normalize the proxy result for callers that fall back after a failed request.
function fetchViaProxy(targetUrl, proxy) {
  return proxyFetch(targetUrl, proxy, { headers: { 'User-Agent': CHROME_UA } })
    .then(r => ({ ok: r.ok, status: r.status, body: r.buffer.toString('utf8') }))
    .catch(() => ({ ok: false, status: 0, body: '' }));
}

module.exports = { CHROME_UA, createPersonalRedisClient, createThrottledLogger, fetchViaProxy };
