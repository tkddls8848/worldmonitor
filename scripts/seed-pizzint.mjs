#!/usr/bin/env node
// Pentagon Pizza Index for the personal setup.
//
// The hosted stack polled PizzINT from the relay (scripts/ais-relay.cjs,
// seedPizzint), and get-pizzint-status and bootstrap read only what the relay
// writes to intelligence:pizzint:seed:v1. collect:personal does not run the
// relay, so without this the indicator never has data.
//
// This runs the relay's own producer block, the exact slice that
// tests/pizzint-seed-publication.test.mjs exercises, against the personal
// store, so the index, its scoring and its health meta stay one implementation.
// Phase 2 moves that block out of the relay into the connectors layer; until
// then a renamed marker fails here loudly rather than drifting.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { CHROME_UA, loadEnvFile } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const require = createRequire(import.meta.url);
const { recordPizzintHistory } = require('./shared/pizzint-history.cjs');
const { pizzintVenuePoint } = require('./shared/pizzint-location.cjs');

const relay = readFileSync(new URL('./ais-relay.cjs', import.meta.url), 'utf8');

function relayBlock(start, end) {
  const from = relay.indexOf(start);
  const to = from < 0 ? -1 : relay.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`ais-relay.cjs no longer has the block starting at "${start}"`);
  return relay.slice(from, to);
}

const REST_URL = process.env.UPSTASH_REDIS_REST_URL;
const REST_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!REST_URL || !REST_TOKEN) {
  console.error('[PizzINT] UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are required');
  process.exit(1);
}

// The relay's helpers speak the same REST protocol over node:http; these keep
// their return shapes (parsed value or null, true on OK, the EVAL result).
async function rest(command) {
  const resp = await fetch(REST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REST_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(command),
    signal: AbortSignal.timeout(5_000),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return (await resp.json())?.result;
}

const deps = {
  CHROME_UA,
  pizzintVenuePoint,
  recordPizzintHistory,
  upstashGet: async (key) => {
    try {
      const raw = await rest(['GET', key]);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  upstashSet: async (key, value, ttlSeconds) => {
    try { return (await rest(['SET', key, JSON.stringify(value), 'EX', String(ttlSeconds)])) === 'OK'; } catch { return false; }
  },
  upstashEval: async (script, keys, args) => {
    try { return await rest(['EVAL', script, String(keys.length), ...keys, ...args.map(String)]); } catch { return null; }
  },
};

const context = vm.createContext({
  ...deps,
  console, process, fetch, AbortSignal, URL, Date, structuredClone, setTimeout, clearTimeout,
});
vm.runInContext(
  relayBlock('function buildEnvelope(', '// Envelope-aware read.')
  + relayBlock('async function envelopeRead(', 'function notifySimpleHash(')
  + relayBlock('const PIZZINT_SEED_INTERVAL_MS', 'function startPizzintSeedLoop()'),
  context,
  { filename: 'ais-relay.cjs#pizzint' },
);

// Success means the payload was republished. seed-meta (the health heartbeat)
// is left alone on purpose while every venue is closed or silent: the relay
// refreshes it only within 24h of the last live reading.
const startedAt = Date.now();
await vm.runInContext('seedPizzint()', context);
const payload = await deps.upstashGet('intelligence:pizzint:seed:v1');
if (!Number.isFinite(payload?._seed?.fetchedAt) || payload._seed.fetchedAt < startedAt) {
  console.error('[PizzINT] No observation was published this run');
  process.exit(1);
}
console.log(`\n=== Done (${Date.now() - startedAt}ms) ===`);
