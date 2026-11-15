// SQLite intel-history store (shared/intel-history-store.mjs), the local
// replacement for convex/intelHistory.ts. Behaviour ported from
// convex/__tests__/intelHistory.test.ts: append, timeline, search, prune,
// retract/restore. Every test opens its own database in a temp folder and
// injects the clock.

import { strict as assert } from 'node:assert';
import { describe, it, afterEach } from 'node:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  INTEL_HISTORY_DIMS,
  INTEL_HISTORY_EMBED_MODEL,
  INTEL_HISTORY_RETENTION_MS,
  openIntelHistoryStore,
  resolveIntelHistoryDbPath,
} from '../shared/intel-history-store.mjs';

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1);

const dirs = [];
const stores = [];
afterEach(() => {
  while (stores.length) { try { stores.pop().close(); } catch {} }
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
});

function tempDb(name = 'history.sqlite') {
  const dir = mkdtempSync(join(tmpdir(), 'intel-history-'));
  dirs.push(dir);
  return join(dir, name);
}

function clock(start = T0) {
  let t = start;
  const now = () => t;
  now.set = (value) => { t = value; };
  now.advance = (ms) => { t += ms; };
  return now;
}

function open(file, options) {
  const store = openIntelHistoryStore(file, options);
  stores.push(store);
  return store;
}

/** A unit vector along `axis`, optionally blended toward `blendAxis`. */
function vector(axis = 0, blendAxis = null, blend = 0) {
  const v = new Array(INTEL_HISTORY_DIMS).fill(0);
  v[axis] = 1 - blend;
  if (blendAxis !== null) v[blendAxis] = blend;
  return v;
}

function rec(key, overrides = {}) {
  return {
    dedupeKey: key,
    title: `Event ${key}`,
    summary: `Summary ${key}`,
    country: 'UA',
    category: 'battle',
    sourceUrl: `https://example.test/${key}`,
    occurredAt: T0 - DAY,
    embedding: vector(0),
    ...overrides,
  };
}

/** Direct SQL on the file, for state the store's API deliberately hides. */
function raw(file, sql, ...params) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    const statement = db.prepare(sql);
    return /^\s*select/i.test(sql) ? statement.all(...params) : statement.run(...params);
  } finally {
    db.close();
  }
}

function restamp(file, keys, model) {
  for (const key of keys) raw(file, 'UPDATE intel_history SET embeddingModel = ? WHERE dedupeKey = ?', model, key);
}

function append(store, records, { domain = 'conflict', resource = 'acled', runId = 'run-1' } = {}) {
  return store.append({ domain, resource, runId, records });
}

describe('constants and path', () => {
  it('pins the embedding contract and retention window', () => {
    assert.equal(INTEL_HISTORY_DIMS, 512);
    assert.equal(INTEL_HISTORY_EMBED_MODEL, 'openai/text-embedding-3-small@512');
    assert.equal(INTEL_HISTORY_RETENTION_MS, 180 * 86_400_000);
  });

  it('resolves WM_INTEL_HISTORY_DB or the repo .personal default', () => {
    assert.equal(resolveIntelHistoryDbPath({ WM_INTEL_HISTORY_DB: 'C:/x/h.sqlite' }), 'C:/x/h.sqlite');
    const fallback = resolveIntelHistoryDbPath({});
    assert.match(fallback.replaceAll('\\', '/'), /\/\.personal\/intel-history\.sqlite$/);
    assert.ok(existsSync(join(fallback, '..', '..', 'package.json')), 'default lives under the repo root');
  });
});

describe('append', () => {
  it('first open creates the folder and file', () => {
    const file = join(tempDb(), '..', 'nested', 'deeper', 'history.sqlite');
    const store = open(file, { now: clock() });
    assert.ok(existsSync(file));
    assert.deepEqual(append(store, [rec('a')]), { inserted: 1, skipped: 0, retracted: 0 });
  });

  it('inserts records stamped with the run-level fields and ingestedAt', () => {
    const now = clock();
    const store = open(tempDb(), { now });
    append(store, [rec('a', { occurredAt: T0 - 5 * DAY })], { runId: 'run-7' });
    const { records } = store.timeline({ domain: 'conflict' });
    assert.equal(records.length, 1);
    const [row] = records;
    assert.equal(typeof row.id, 'string');
    assert.deepEqual({ ...row, id: undefined }, {
      id: undefined,
      domain: 'conflict',
      resource: 'acled',
      country: 'UA',
      category: 'battle',
      title: 'Event a',
      summary: 'Summary a',
      sourceUrl: 'https://example.test/a',
      occurredAt: T0 - 5 * DAY,
      ingestedAt: T0,
      runId: 'run-7',
      dedupeKey: 'a',
    });
    assert.equal('embedding' in row, false, 'the vector never leaves the store');
  });

  it('omits absent optional fields from the projection', () => {
    const store = open(tempDb(), { now: clock() });
    append(store, [{ dedupeKey: 'bare', title: 'Bare', occurredAt: T0, embedding: vector(0) }]);
    const [row] = store.timeline({ domain: 'conflict' }).records;
    for (const field of ['country', 'category', 'summary', 'sourceUrl']) {
      assert.equal(field in row, false, `${field} must be absent`);
    }
  });

  it('append stamps model and dedupes within and across runs', () => {
    const file = tempDb();
    const store = open(file, { now: clock() });
    assert.deepEqual(append(store, [rec('dup'), rec('dup')]), { inserted: 1, skipped: 1, retracted: 0 });
    assert.deepEqual(append(store, [rec('dup')], { runId: 'run-2' }), { inserted: 0, skipped: 1, retracted: 0 });

    // The stamp is a storage column, not part of the projection; read it raw.
    const rows = raw(file, 'SELECT dedupeKey, runId, embeddingModel, length(embedding) AS bytes FROM intel_history');
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { dedupeKey: 'dup', runId: 'run-1', embeddingModel: INTEL_HISTORY_EMBED_MODEL, bytes: 512 * 4 },
    ]);
  });

  it('append rejects a 511-dim or non-finite vector', () => {
    const store = open(tempDb(), { now: clock() });
    const bad = [
      new Array(511).fill(0.1),
      Object.assign(vector(0), { 3: Number.NaN }),
      Object.assign(vector(0), { 4: Number.POSITIVE_INFINITY }),
      Object.assign(vector(0), { 5: 1e39 }), // finite as float64, Infinity as Float32
    ];
    for (const embedding of bad) {
      assert.throws(() => append(store, [rec('ok'), rec('bad', { embedding })]), /INVALID_RECORD/);
    }
    assert.equal(store.timeline({ domain: 'conflict' }).records.length, 0, 'the whole call is rejected');
  });

  it('append rejects 101 records', () => {
    const store = open(tempDb(), { now: clock() });
    const records = Array.from({ length: 101 }, (_, i) => rec(`k${i}`));
    assert.throws(() => append(store, records), /TOO_MANY_RECORDS/);
    assert.equal(append(store, records.slice(0, 100)).inserted, 100);
  });

  it('two connections appending the same keys insert each once', () => {
    const file = tempDb();
    const a = open(file, { now: clock() });
    const b = open(file, { now: clock() });
    const records = Array.from({ length: 50 }, (_, i) => rec(`same-${i}`, { occurredAt: T0 - i }));
    const totals = { inserted: 0, skipped: 0 };
    for (let i = 0; i < records.length; i += 5) {
      for (const store of [a, b]) {
        const result = append(store, records.slice(i, i + 5));
        totals.inserted += result.inserted;
        totals.skipped += result.skipped;
      }
    }
    assert.deepEqual(totals, { inserted: 50, skipped: 50 });
    assert.equal(a.timeline({ domain: 'conflict', limit: 200 }).records.length, 50);
  });

  it('two processes appending the same keys at once insert each once', async () => {
    const file = tempDb();
    const storeUrl = new URL('../shared/intel-history-store.mjs', import.meta.url).href;
    const script = `
      const { openIntelHistoryStore, INTEL_HISTORY_DIMS } = await import(${JSON.stringify(storeUrl)});
      const store = openIntelHistoryStore(process.argv[1]);
      const embedding = new Array(INTEL_HISTORY_DIMS).fill(0.01);
      let inserted = 0;
      for (let round = 0; round < 10; round++) {
        const records = Array.from({ length: 50 }, (_, i) => ({ dedupeKey: 'race-' + i, title: 't' + i, occurredAt: i, embedding }));
        inserted += store.append({ domain: 'conflict', resource: 'race', runId: 'r' + round, records }).inserted;
      }
      store.close();
      console.log(inserted);
    `;
    const { spawn } = await import('node:child_process');
    const run = () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--input-type=module', '-e', script, file], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('close', (code) => (code === 0 ? resolve(Number(out.trim())) : reject(new Error(err))));
    });
    const counts = await Promise.all([run(), run()]);
    assert.equal(counts[0] + counts[1], 50, `inserted per process: ${counts}`);
    assert.deepEqual(raw(file, 'SELECT COUNT(*) AS n, COUNT(DISTINCT dedupeKey) AS k FROM intel_history').map((r) => ({ ...r })), [{ n: 50, k: 50 }]);
  });

  it('append prunes rows older than 180 days', () => {
    const now = clock();
    const store = open(tempDb(), { now });
    // A backfilled event that HAPPENED long ago survives: retention ages by ingestedAt.
    append(store, [rec('old', { occurredAt: T0 - 400 * DAY })]);
    now.advance(179 * DAY);
    append(store, [rec('mid')]);
    assert.deepEqual(store.timeline({ domain: 'conflict' }).records.map((r) => r.dedupeKey).sort(), ['mid', 'old']);

    now.advance(2 * DAY); // 'old' was ingested 181 days ago, 'mid' 2 days ago
    append(store, [rec('new')]);
    assert.deepEqual(store.timeline({ domain: 'conflict' }).records.map((r) => r.dedupeKey).sort(), ['mid', 'new']);
  });
});

describe('timeline', () => {
  function seedFive(store) {
    append(store, [0, 1, 2, 3, 4].map((i) => rec(`e${i}`, { occurredAt: T0 - i * DAY })));
  }

  it('timeline orders newest first and pages with a cursor', () => {
    const store = open(tempDb(), { now: clock() });
    seedFive(store);
    const seen = [];
    let cursor;
    let pages = 0;
    let last;
    do {
      last = store.timeline({ domain: 'conflict', limit: 2, cursor });
      assert.equal(last.partial, false);
      seen.push(...last.records.map((r) => r.dedupeKey));
      cursor = last.nextCursor ?? undefined;
      pages += 1;
    } while (cursor && pages < 10);
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['e0', 'e1', 'e2', 'e3', 'e4']);
    assert.equal(new Set(seen).size, 5);
    assert.equal(last.nextCursor, null);
  });

  it('continues through equal event times without repeating or losing records', () => {
    const store = open(tempDb(), { now: clock() });
    append(store, Array.from({ length: 5 }, (_, i) => rec(`tie${i}`, { occurredAt: T0 })));
    const seen = [];
    let cursor;
    do {
      const page = store.timeline({ domain: 'conflict', limit: 2, cursor });
      seen.push(...page.records.map((r) => r.dedupeKey));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    assert.deepEqual([...seen].sort(), ['tie0', 'tie1', 'tie2', 'tie3', 'tie4']);
    // Ties break by id descending: the last inserted comes first.
    assert.deepEqual(seen, ['tie4', 'tie3', 'tie2', 'tie1', 'tie0']);
  });

  it('applies domain, country and the inclusive occurredAt range together', () => {
    const store = open(tempDb(), { now: clock() });
    append(store, [
      rec('ua-in', { occurredAt: T0 - 2 * DAY }),
      rec('ua-edge', { occurredAt: T0 - 4 * DAY }),
      rec('ua-out', { occurredAt: T0 - 9 * DAY }),
      rec('lb-in', { country: 'LB', occurredAt: T0 - 2 * DAY }),
    ]);
    append(store, [rec('energy-ua', { occurredAt: T0 - 2 * DAY })], { domain: 'energy', resource: 'intelligence' });

    const both = store.timeline({ domain: 'conflict', country: 'UA', from: T0 - 4 * DAY, to: T0 });
    assert.deepEqual(both.records.map((r) => r.dedupeKey), ['ua-in', 'ua-edge']);

    const countryOnly = store.timeline({ country: 'UA', from: T0 - 3 * DAY });
    assert.deepEqual(countryOnly.records.map((r) => r.dedupeKey).sort(), ['energy-ua', 'ua-in']);
  });

  it('honours an explicit limit and clamps it to the documented maximum', () => {
    const store = open(tempDb(), { now: clock() });
    for (let start = 0; start < 260; start += 100) {
      append(store, Array.from({ length: Math.min(100, 260 - start) }, (_, i) => rec(`m${start + i}`, { occurredAt: T0 - start - i })));
    }
    assert.equal(store.timeline({ domain: 'conflict' }).records.length, 50);
    assert.equal(store.timeline({ domain: 'conflict', limit: 3 }).records.length, 3);
    assert.equal(store.timeline({ domain: 'conflict', limit: 5000 }).records.length, 200);
  });

  it('timeline requires domain or country', () => {
    const store = open(tempDb(), { now: clock() });
    assert.throws(() => store.timeline({}), (err) => err.name === 'ValidationError');
    assert.throws(() => store.timeline({ from: 1, to: 2 }), (err) => err.name === 'ValidationError');
  });

  it('timeline rejects a forged cursor', () => {
    const store = open(tempDb(), { now: clock() });
    seedFive(store);
    const forged = [
      'not-a-cursor',
      Buffer.from('abc:def').toString('base64url'),
      Buffer.from('123').toString('base64url'),
      Buffer.from('123:-4').toString('base64url'),
      '!!!',
    ];
    for (const cursor of forged) {
      assert.throws(
        () => store.timeline({ domain: 'conflict', cursor }),
        (err) => err.name === 'ValidationError' && err.field === 'cursor',
        `cursor ${cursor} must be rejected`,
      );
    }
  });
});

describe('search', () => {
  it('search ranks by cosine and applies minScore', () => {
    const store = open(tempDb(), { now: clock() });
    append(store, [
      rec('exact', { embedding: vector(0) }),
      rec('near', { embedding: vector(0, 1, 0.3) }),
      rec('orthogonal', { embedding: vector(2) }),
    ]);
    const all = store.search({ vector: vector(0) });
    assert.deepEqual(all.records.map((r) => r.dedupeKey), ['exact', 'near', 'orthogonal']);
    assert.ok(Math.abs(all.records[0].score - 1) < 1e-6, `top score ${all.records[0].score}`);
    assert.ok(all.records[1].score < 1 && all.records[1].score > 0.5);
    assert.equal(all.partial, false);
    assert.equal('embedding' in all.records[0], false);

    const floor = store.search({ vector: vector(0), minScore: 0.99 });
    assert.deepEqual(floor.records.map((r) => r.dedupeKey), ['exact']);
  });

  it('search drops foreign-model rows and marks partial', () => {
    const file = tempDb();
    const store = open(file, { now: clock() });
    append(store, [
      rec('cur-1', { embedding: vector(0, 1, 0.2) }),
      rec('cur-2', { embedding: vector(0, 1, 0.4) }),
      rec('foreign-1'), rec('foreign-2'), rec('foreign-3'),
    ]);
    // Three rows from another vector space, each an exact (1.0) match.
    restamp(file, ['foreign-1', 'foreign-2', 'foreign-3'], 'openai/text-embedding-3-large@512');
    const result = store.search({ vector: vector(0), limit: 2 });
    assert.deepEqual(result.records.map((r) => r.dedupeKey), ['cur-1', 'cur-2']);
    assert.equal(result.partial, true);
  });

  it('legacy unstamped rows count as the current model', () => {
    const file = tempDb();
    const store = open(file, { now: clock() });
    append(store, [rec('legacy'), rec('stamped', { embedding: vector(0, 1, 0.5) })]);
    restamp(file, ['legacy'], null);
    const result = store.search({ vector: vector(0) });
    assert.deepEqual(result.records.map((r) => r.dedupeKey), ['legacy', 'stamped']);
    assert.equal(result.partial, false);
  });

  it('applies domain, country and occurredAt scope before ranking', () => {
    const store = open(tempDb(), { now: clock() });
    append(store, [
      rec('ua-recent', { occurredAt: T0 - DAY, embedding: vector(0, 1, 0.1) }),
      rec('ua-old', { occurredAt: T0 - 30 * DAY }),
      rec('lb', { country: 'LB' }),
    ]);
    append(store, [rec('energy')], { domain: 'energy', resource: 'intelligence' });
    const scoped = store.search({ vector: vector(0), domain: 'conflict', country: 'UA', from: T0 - 7 * DAY, to: T0 });
    assert.deepEqual(scoped.records.map((r) => r.dedupeKey), ['ua-recent']);
    const countryOnly = store.search({ vector: vector(0), country: 'LB' });
    assert.deepEqual(countryOnly.records.map((r) => r.dedupeKey), ['lb']);
  });

  it('clamps limit and rejects a wrong-dimension vector or out-of-range minScore', () => {
    const store = open(tempDb(), { now: clock() });
    append(store, Array.from({ length: 70 }, (_, i) => rec(`s${i}`)));
    assert.equal(store.search({ vector: vector(0) }).records.length, 20);
    assert.equal(store.search({ vector: vector(0), limit: 999 }).records.length, 64);
    const isValidation = (err) => err.name === 'ValidationError';
    assert.throws(() => store.search({ vector: new Array(511).fill(0) }), isValidation);
    assert.throws(() => store.search({ vector: Object.assign(vector(0), { 1: Number.NaN }) }), isValidation);
    assert.throws(() => store.search({ vector: vector(0), minScore: 1.5 }), isValidation);
    assert.throws(() => store.search({ vector: vector(0), minScore: -1.01 }), isValidation);
  });
});

describe('retract and restore', () => {
  it('retracted keys are not re-inserted', () => {
    const store = open(tempDb(), { now: clock() });
    append(store, [rec('poison')]);
    const retracted = store.retract({ dedupeKeys: ['poison'], reason: 'poisoned feed item' });
    assert.equal(retracted.retracted, 1);
    assert.equal(retracted.deleted, 1);
    assert.equal(store.timeline({ domain: 'conflict' }).records.length, 0);

    assert.deepEqual(append(store, [rec('poison')]), { inserted: 0, skipped: 0, retracted: 1 });
    assert.equal(store.timeline({ domain: 'conflict' }).records.length, 0);

    assert.deepEqual(store.restore({ dedupeKeys: ['poison'] }), { restored: 1, notRetracted: [] });
    assert.deepEqual(append(store, [rec('poison')]), { inserted: 1, skipped: 0, retracted: 0 });
  });

  it('a retracted key blocks only itself inside a mixed batch', () => {
    const store = open(tempDb(), { now: clock() });
    store.retract({ dedupeKeys: ['bad'], reason: 'wrong' });
    assert.deepEqual(append(store, [rec('good'), rec('bad'), rec('bad')]), { inserted: 1, skipped: 1, retracted: 1 });
  });

  it('resolves ids, reports unresolved ones, and refuses an all-unresolved batch', () => {
    const store = open(tempDb(), { now: clock() });
    append(store, [rec('by-id')]);
    const [row] = store.timeline({ domain: 'conflict' }).records;
    const mixed = store.retract({ ids: [row.id, '999999', 'garbage'], dedupeKeys: ['by-id'], reason: 'mixed' });
    assert.deepEqual(mixed.keys, ['by-id']);
    assert.deepEqual(mixed.unresolvedIds, ['999999', 'garbage']);
    assert.equal(mixed.deleted, 1);
    assert.throws(() => store.retract({ ids: ['999999'], reason: 'gone' }), /no identifier resolved/);
  });

  it('re-retracting refreshes the tombstone instead of duplicating it', () => {
    const now = clock();
    const store = open(tempDb(), { now });
    store.retract({ dedupeKeys: ['k'], reason: 'first' });
    now.advance(DAY);
    const again = store.retract({ dedupeKeys: ['k'], reason: 'second' });
    assert.equal(again.tombstoned, 0);
    assert.equal(again.refreshed, 1);
    assert.deepEqual(store.listRetractions({}).records, [{ dedupeKey: 'k', retractedAt: T0 + DAY, reason: 'second' }]);
  });

  it('validates identifier budgets and the reason', () => {
    const store = open(tempDb(), { now: clock() });
    assert.throws(() => store.retract({ dedupeKeys: [], reason: 'r' }), /at least one/);
    assert.throws(() => store.retract({ dedupeKeys: Array.from({ length: 101 }, (_, i) => `k${i}`), reason: 'r' }), /at most 100/);
    assert.throws(() => store.retract({ dedupeKeys: ['k'], reason: '  ' }), /reason is required/);
    assert.throws(() => store.restore({ dedupeKeys: Array.from({ length: 101 }, (_, i) => `k${i}`) }), /at most 100/);
    assert.throws(() => store.restore({ dedupeKeys: [] }), /dedupeKeys/);
  });

  it('restore reports keys that were never retracted and dedupes repeats', () => {
    const store = open(tempDb(), { now: clock() });
    store.retract({ dedupeKeys: ['a'], reason: 'r' });
    assert.deepEqual(store.restore({ dedupeKeys: ['a', 'a', 'never'] }), { restored: 1, notRetracted: ['never'] });
  });

  it('lists tombstones newest first and flags a truncated page', () => {
    const now = clock();
    const store = open(tempDb(), { now });
    for (const key of ['one', 'two', 'three']) {
      store.retract({ dedupeKeys: [key], reason: `why ${key}` });
      now.advance(1000);
    }
    const page = store.listRetractions({ limit: 2 });
    assert.deepEqual(page.records.map((r) => r.dedupeKey), ['three', 'two']);
    assert.equal(page.partial, true);
    assert.equal(store.listRetractions({}).partial, false);
  });

  it('a suppressed append refreshes the tombstone; an untouched one expires after 180 days', () => {
    const now = clock();
    const store = open(tempDb(), { now });
    store.retract({ dedupeKeys: ['live', 'stale'], reason: 'r' });
    now.advance(100 * DAY);
    append(store, [rec('live')]); // the feed still serves it: clock restarts
    now.advance(81 * DAY); // 181 days after the retraction, 81 after the last suppression
    assert.deepEqual(append(store, [rec('live'), rec('stale')]), { inserted: 1, skipped: 0, retracted: 1 });
    assert.deepEqual(store.listRetractions({}).records.map((r) => r.dedupeKey), ['live']);
  });
});

describe('read-only connections', () => {
  it('opens a database whose writer has already closed', () => {
    const file = tempDb();
    const writer = openIntelHistoryStore(file, { now: clock() });
    append(writer, [rec('a')]);
    writer.close();
    const reader = open(file, { readOnly: true });
    assert.equal(reader.timeline({ domain: 'conflict' }).records.length, 1);
  });

  it('refuses to open a database that does not exist yet', () => {
    const file = tempDb();
    assert.throws(() => openIntelHistoryStore(file, { readOnly: true }));
    assert.equal(existsSync(file), false, 'a reader never creates the file');
  });

  it('reads what a writer committed and refuses to write', () => {
    const file = tempDb();
    const writer = open(file, { now: clock() });
    append(writer, [rec('a')]);
    const reader = open(file, { readOnly: true });
    assert.equal(reader.timeline({ domain: 'conflict' }).records.length, 1);
    append(writer, [rec('b')]);
    assert.equal(reader.timeline({ domain: 'conflict' }).records.length, 2, 'a long-lived reader sees new commits');
    assert.throws(() => reader.append({ domain: 'conflict', resource: 'acled', runId: 'r', records: [rec('c')] }), /read-only/);
  });
});
