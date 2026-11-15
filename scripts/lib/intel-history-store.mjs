/**
 * Local SQLite store for the historical intelligence memory (#5694), the
 * personal-mode replacement for convex/intelHistory.ts.
 *
 * Seeders append the events they published (scripts/_seed-history.mjs), the
 * three intelligence RPCs read them back chronologically (`timeline`) or by
 * cosine similarity (`search`) through server/_shared/intel-history-client.ts,
 * and an operator can take a poisoned row back with `retract`
 * (scripts/retract-intel-history.mjs). Semantics follow the Convex module:
 * idempotent on `dedupeKey`, tombstones keep a retracted identity out, every
 * row is stamped with the vector space it was embedded in, and history ages
 * out 180 days after ingest. The retention prune runs inside each append's
 * transaction instead of a daily cron.
 *
 * The public import path is shared/intel-history-store.mjs. The code lives
 * under scripts/ because collectors may not import outside scripts/
 * (tests/scripts-railway-nixpacks-no-escape-import.test.mts); server code
 * already imports scripts/lib the same way.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Dimension of every stored and query vector (EMBED_DIMS in brief-dedup-consts.mjs). */
export const INTEL_HISTORY_DIMS = 512;

/** Vector space stamped on every row: `${EMBED_MODEL}@${EMBED_DIMS}`. */
export const INTEL_HISTORY_EMBED_MODEL = 'openai/text-embedding-3-small@512';

/** Rows age out by ingestedAt, tombstones by retractedAt, after this long. */
export const INTEL_HISTORY_RETENTION_MS = 180 * 86_400_000;

export const INTEL_HISTORY_MAX_APPEND_RECORDS = 100;
export const INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS = 100;

const TIMELINE_DEFAULT_LIMIT = 50;
export const TIMELINE_MAX_LIMIT = 200;
const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 64;
const RETRACTION_PAGE_MAX = 200;
const IDENTIFIER_MAX_CHARS = 256;

/** Rows written before the model stamp existed were all made by the one model ever used. */
const LEGACY_EMBEDDING_MODEL = 'openai/text-embedding-3-small@512';

/** A caller-supplied argument the store refuses. `field` names the argument. */
export class ValidationError extends Error {
  constructor(field, message) {
    super(message);
    this.name = 'ValidationError';
    this.field = field;
  }
}

/** A write the store refuses. `code` is TOO_MANY_RECORDS or INVALID_RECORD. */
export class IntelHistoryStoreError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = 'IntelHistoryStoreError';
    this.code = code;
  }
}

function findRepoRoot() {
  // Walk up rather than use a fixed offset: this module is also bundled into
  // api/<domain>/v1/[rpc].js, where import.meta.url names the bundle.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (existsSync(join(dir, '.nvmrc')) && existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

/** `WM_INTEL_HISTORY_DB` when set, otherwise `<repo>/.personal/intel-history.sqlite`. */
export function resolveIntelHistoryDbPath(env = process.env) {
  const configured = typeof env?.WM_INTEL_HISTORY_DB === 'string' ? env.WM_INTEL_HISTORY_DB.trim() : '';
  if (configured) return configured;
  return join(findRepoRoot(), '.personal', 'intel-history.sqlite');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

const present = (value) => typeof value === 'string' && value !== '';

function optionalBound(value, field) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(field, `${field} must be a finite number`);
  }
  return value;
}

/** Validate a vector and pack it as Float32. Returns null when it is unusable. */
function packVector(embedding) {
  if (!(Array.isArray(embedding) || ArrayBuffer.isView(embedding)) || embedding.length !== INTEL_HISTORY_DIMS) return null;
  const packed = new Float32Array(INTEL_HISTORY_DIMS);
  for (let i = 0; i < INTEL_HISTORY_DIMS; i++) {
    const component = embedding[i];
    // A value finite in float64 can still overflow Float32; check after rounding.
    if (typeof component !== 'number' || !Number.isFinite(component) || !Number.isFinite(Math.fround(component))) return null;
    packed[i] = component;
  }
  return packed;
}

function unpackVector(blob) {
  if (!(blob instanceof Uint8Array) || blob.byteLength !== INTEL_HISTORY_DIMS * 4) return null;
  const aligned = blob.byteOffset % 4 === 0 ? blob : blob.slice();
  return new Float32Array(aligned.buffer, aligned.byteOffset, INTEL_HISTORY_DIMS);
}

function norm(vector) {
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  return Math.sqrt(sum);
}

function cosine(query, queryNorm, row) {
  let dot = 0;
  let rowSum = 0;
  for (let i = 0; i < INTEL_HISTORY_DIMS; i++) {
    dot += query[i] * row[i];
    rowSum += row[i] * row[i];
  }
  const denominator = queryNorm * Math.sqrt(rowSum);
  return denominator > 0 ? dot / denominator : 0;
}

function optionalText(value, field) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new IntelHistoryStoreError('INVALID_RECORD', `${field} must be a string`);
  return value === '' ? null : value;
}

function prepareRecord(raw, index) {
  if (!raw || typeof raw !== 'object') throw new IntelHistoryStoreError('INVALID_RECORD', `record ${index} is not an object`);
  if (typeof raw.dedupeKey !== 'string' || !raw.dedupeKey) {
    throw new IntelHistoryStoreError('INVALID_RECORD', `record ${index} needs a dedupeKey`);
  }
  if (typeof raw.title !== 'string') throw new IntelHistoryStoreError('INVALID_RECORD', `record ${index} needs a title`);
  if (typeof raw.occurredAt !== 'number' || !Number.isFinite(raw.occurredAt)) {
    throw new IntelHistoryStoreError('INVALID_RECORD', `record ${index} needs a finite occurredAt`);
  }
  const packed = packVector(raw.embedding);
  if (!packed) {
    throw new IntelHistoryStoreError(
      'INVALID_RECORD',
      `record ${index} embedding must be ${INTEL_HISTORY_DIMS} finite numbers`,
    );
  }
  return {
    dedupeKey: raw.dedupeKey,
    title: raw.title,
    occurredAt: raw.occurredAt,
    country: optionalText(raw.country, 'country'),
    category: optionalText(raw.category, 'category'),
    summary: optionalText(raw.summary, 'summary'),
    sourceUrl: optionalText(raw.sourceUrl, 'sourceUrl'),
    embedding: new Uint8Array(packed.buffer),
  };
}

/** The read projection (convex projectRecord): no vector, absent optionals omitted. */
function projectRecord(row) {
  const record = {
    id: String(row.id),
    domain: row.domain,
    resource: row.resource,
  };
  if (row.country !== null) record.country = row.country;
  if (row.category !== null) record.category = row.category;
  record.title = row.title;
  if (row.summary !== null) record.summary = row.summary;
  if (row.sourceUrl !== null) record.sourceUrl = row.sourceUrl;
  record.occurredAt = row.occurredAt;
  record.ingestedAt = row.ingestedAt;
  record.runId = row.runId;
  record.dedupeKey = row.dedupeKey;
  return record;
}

// Opaque continuation: base64url("<occurredAt>:<id>") of the last row served.
function encodeCursor(row) {
  return Buffer.from(`${row.occurredAt}:${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor) {
  const invalid = () => new ValidationError('cursor', 'Invalid cursor. Restart from the first page with unchanged filters.');
  if (typeof cursor !== 'string' || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalid();
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== cursor) throw invalid();
  const split = decoded.lastIndexOf(':');
  if (split <= 0) throw invalid();
  const occurredText = decoded.slice(0, split);
  const idText = decoded.slice(split + 1);
  const occurredAt = Number(occurredText);
  const id = Number(idText);
  if (!Number.isFinite(occurredAt) || String(occurredAt) !== occurredText) throw invalid();
  if (!Number.isSafeInteger(id) || id <= 0 || String(id) !== idText) throw invalid();
  return { occurredAt, id };
}

function scopeClause({ domain, country, from, to }) {
  const where = [];
  const params = [];
  if (present(domain)) { where.push('domain = ?'); params.push(domain); }
  if (present(country)) { where.push('country = ?'); params.push(country); }
  if (from !== undefined) { where.push('occurredAt >= ?'); params.push(from); }
  if (to !== undefined) { where.push('occurredAt <= ?'); params.push(to); }
  return { where, params };
}

function checkIdentifiers(values, flag) {
  if (values === undefined || values === null) return [];
  if (!Array.isArray(values)) throw new Error(`intelHistory: ${flag} must be an array`);
  for (const value of values) {
    if (typeof value !== 'string' || !value || value !== value.trim() || value.length > IDENTIFIER_MAX_CHARS) {
      throw new Error(`intelHistory: invalid ${flag} entry ${JSON.stringify(value)}`);
    }
  }
  return values;
}

function assertIdentifierBudget(total, accepts) {
  if (total === 0) throw new Error(`intelHistory: at least one of ${accepts} is required`);
  if (total > INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS) {
    throw new Error(`intelHistory: at most ${INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS} identifiers per call, got ${total}`);
  }
}

const RECORD_COLUMNS = 'id, domain, resource, country, category, title, summary, sourceUrl, occurredAt, ingestedAt, runId, dedupeKey';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS intel_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    domain TEXT NOT NULL,
    resource TEXT NOT NULL,
    country TEXT,
    category TEXT,
    title TEXT NOT NULL,
    summary TEXT,
    sourceUrl TEXT,
    occurredAt INTEGER NOT NULL,
    ingestedAt INTEGER NOT NULL,
    runId TEXT NOT NULL,
    dedupeKey TEXT NOT NULL UNIQUE,
    embedding BLOB NOT NULL,
    embeddingModel TEXT
  );
  CREATE INDEX IF NOT EXISTS intel_history_by_domain ON intel_history(domain, occurredAt DESC, id DESC);
  CREATE INDEX IF NOT EXISTS intel_history_by_country ON intel_history(country, occurredAt DESC, id DESC);
  CREATE INDEX IF NOT EXISTS intel_history_by_ingested ON intel_history(ingestedAt);
  CREATE TABLE IF NOT EXISTS intel_history_retractions (
    dedupeKey TEXT PRIMARY KEY,
    retractedAt INTEGER NOT NULL,
    reason TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS intel_history_retractions_by_time ON intel_history_retractions(retractedAt);
`;

/**
 * Open the history database. Writers create the folder, file and tables; a
 * read-only connection requires an existing database.
 */
export function openIntelHistoryStore(filename, { now = Date.now, readOnly = false } = {}) {
  if (typeof filename !== 'string' || !filename) throw new Error('Intel history database path is required');
  const file = isAbsolute(filename) ? filename : resolve(filename);
  if (!readOnly) mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file, { readOnly });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    if (!readOnly) {
      db.exec('PRAGMA journal_mode = WAL');
      db.exec(SCHEMA);
    }

    const assertWritable = () => { if (readOnly) throw new Error('Intel history database is read-only'); };
    function transaction(work) {
      assertWritable();
      // IMMEDIATE takes the write lock up front, so two collectors appending
      // the same keys serialize instead of both passing the dedupe read.
      db.exec('BEGIN IMMEDIATE');
      try { const result = work(); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    }

    const statements = new Map();
    const sql = (text) => {
      let statement = statements.get(text);
      if (!statement) { statement = db.prepare(text); statements.set(text, statement); }
      return statement;
    };

    function append({ domain, resource, runId, records } = {}) {
      assertWritable();
      if (!present(domain)) throw new IntelHistoryStoreError('INVALID_RECORD', 'domain is required');
      if (!present(resource)) throw new IntelHistoryStoreError('INVALID_RECORD', 'resource is required');
      if (!Array.isArray(records)) throw new IntelHistoryStoreError('INVALID_RECORD', 'records must be an array');
      if (records.length > INTEL_HISTORY_MAX_APPEND_RECORDS) {
        throw new IntelHistoryStoreError(
          'TOO_MANY_RECORDS',
          `at most ${INTEL_HISTORY_MAX_APPEND_RECORDS} records per call, got ${records.length}`,
        );
      }
      // Validate the whole call before the first write.
      const prepared = records.map(prepareRecord);
      const run = typeof runId === 'string' ? runId : String(runId ?? '');

      return transaction(() => {
        const at = now();
        const cutoff = at - INTEL_HISTORY_RETENTION_MS;
        sql('DELETE FROM intel_history WHERE ingestedAt < ?').run(cutoff);
        sql('DELETE FROM intel_history_retractions WHERE retractedAt < ?').run(cutoff);

        let inserted = 0;
        let skipped = 0;
        let retracted = 0;
        const seenInBatch = new Set();
        for (const rec of prepared) {
          if (seenInBatch.has(rec.dedupeKey)) { skipped += 1; continue; }
          seenInBatch.add(rec.dedupeKey);
          // A tombstoned key is still being served by the feed: restart its clock.
          const tombstone = sql('UPDATE intel_history_retractions SET retractedAt = ? WHERE dedupeKey = ?').run(at, rec.dedupeKey);
          if (tombstone.changes > 0) { retracted += 1; continue; }
          const result = sql(`INSERT INTO intel_history
            (domain, resource, country, category, title, summary, sourceUrl, occurredAt, ingestedAt, runId, dedupeKey, embedding, embeddingModel)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(dedupeKey) DO NOTHING`).run(
            domain, resource, rec.country, rec.category, rec.title, rec.summary, rec.sourceUrl,
            rec.occurredAt, at, run, rec.dedupeKey, rec.embedding, INTEL_HISTORY_EMBED_MODEL,
          );
          if (result.changes > 0) inserted += 1;
          else skipped += 1;
        }
        return { inserted, skipped, retracted };
      });
    }

    function timeline({ domain, country, from, to, limit, cursor } = {}) {
      if (!present(domain) && !present(country)) {
        throw new ValidationError('domain', 'at least one of domain or country is required');
      }
      const pageSize = clamp(limit ?? TIMELINE_DEFAULT_LIMIT, 1, TIMELINE_MAX_LIMIT);
      const { where, params } = scopeClause({
        domain, country, from: optionalBound(from, 'from'), to: optionalBound(to, 'to'),
      });
      if (cursor !== undefined && cursor !== null && cursor !== '') {
        const after = decodeCursor(cursor);
        where.push('(occurredAt < ? OR (occurredAt = ? AND id < ?))');
        params.push(after.occurredAt, after.occurredAt, after.id);
      }
      const rows = sql(`SELECT ${RECORD_COLUMNS} FROM intel_history WHERE ${where.join(' AND ')}
        ORDER BY occurredAt DESC, id DESC LIMIT ?`).all(...params, pageSize + 1);
      const page = rows.slice(0, pageSize);
      return {
        records: page.map(projectRecord),
        // Every matching row is reachable through the cursor, so no page is partial.
        partial: false,
        nextCursor: rows.length > pageSize ? encodeCursor(page.at(-1)) : null,
      };
    }

    function search({ vector, domain, country, from, to, limit, minScore } = {}) {
      const query = packVector(vector);
      if (!query) throw new ValidationError('vector', `vector must be ${INTEL_HISTORY_DIMS} finite numbers`);
      if (minScore !== undefined && minScore !== null
        && (typeof minScore !== 'number' || !Number.isFinite(minScore) || minScore < -1 || minScore > 1)) {
        throw new ValidationError('minScore', 'minScore must be between -1 and 1');
      }
      const pageSize = clamp(limit ?? SEARCH_DEFAULT_LIMIT, 1, SEARCH_MAX_LIMIT);
      const { where, params } = scopeClause({
        domain, country, from: optionalBound(from, 'from'), to: optionalBound(to, 'to'),
      });
      const scoped = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const queryNorm = norm(query);

      let partial = false;
      const scored = [];
      for (const row of sql(`SELECT ${RECORD_COLUMNS}, embedding, embeddingModel FROM intel_history ${scoped}`).iterate(...params)) {
        // A row from another vector space scored against this query is a
        // number, not a similarity: drop it and report the answer as partial.
        if ((row.embeddingModel ?? LEGACY_EMBEDDING_MODEL) !== INTEL_HISTORY_EMBED_MODEL) { partial = true; continue; }
        const stored = unpackVector(row.embedding);
        if (!stored) { partial = true; continue; }
        const score = cosine(query, queryNorm, stored);
        if (minScore !== undefined && minScore !== null && score < minScore) continue;
        scored.push({ row, score });
      }
      scored.sort((a, b) => b.score - a.score || b.row.occurredAt - a.row.occurredAt || b.row.id - a.row.id);
      return {
        records: scored.slice(0, pageSize).map(({ row, score }) => ({ ...projectRecord(row), score })),
        partial,
      };
    }

    function retract({ ids, dedupeKeys, reason } = {}) {
      assertWritable();
      const idList = checkIdentifiers(ids, 'ids');
      const keyList = checkIdentifiers(dedupeKeys, 'dedupeKeys');
      assertIdentifierBudget(idList.length + keyList.length, 'ids or dedupeKeys');
      const why = typeof reason === 'string' ? reason.trim() : '';
      if (!why) throw new Error('intelHistory.retract: reason is required');

      return transaction(() => {
        const keys = new Set(keyList);
        const unresolvedIds = [];
        for (const raw of idList) {
          const row = /^[1-9]\d*$/.test(raw) ? sql('SELECT dedupeKey FROM intel_history WHERE id = ?').get(Number(raw)) : undefined;
          if (row) keys.add(row.dedupeKey);
          else unresolvedIds.push(raw);
        }
        if (keys.size === 0) {
          throw new Error(
            'intelHistory.retract: no identifier resolved to a dedupeKey — nothing was tombstoned. '
            + `Unresolved ids: ${unresolvedIds.join(', ')}. A deleted or pruned row cannot be `
            + 'retracted by id; re-run with --dedupe-key to suppress the identity itself.',
          );
        }
        const at = now();
        let deleted = 0;
        let tombstoned = 0;
        let refreshed = 0;
        for (const key of keys) {
          deleted += Number(sql('DELETE FROM intel_history WHERE dedupeKey = ?').run(key).changes);
          const updated = sql('UPDATE intel_history_retractions SET retractedAt = ?, reason = ? WHERE dedupeKey = ?').run(at, why, key);
          if (updated.changes > 0) refreshed += 1;
          else {
            sql('INSERT INTO intel_history_retractions (dedupeKey, retractedAt, reason) VALUES (?, ?, ?)').run(key, at, why);
            tombstoned += 1;
          }
        }
        return { retracted: keys.size, deleted, tombstoned, refreshed, keys: [...keys], unresolvedIds };
      });
    }

    function restore({ dedupeKeys } = {}) {
      assertWritable();
      const keyList = checkIdentifiers(dedupeKeys, 'dedupeKeys');
      assertIdentifierBudget(keyList.length, 'dedupeKeys');
      return transaction(() => {
        let restored = 0;
        const notRetracted = [];
        for (const key of new Set(keyList)) {
          const removed = Number(sql('DELETE FROM intel_history_retractions WHERE dedupeKey = ?').run(key).changes);
          if (removed === 0) notRetracted.push(key);
          restored += removed;
        }
        return { restored, notRetracted };
      });
    }

    function listRetractions({ limit } = {}) {
      const pageSize = clamp(limit ?? RETRACTION_PAGE_MAX, 1, RETRACTION_PAGE_MAX);
      const rows = sql(`SELECT dedupeKey, retractedAt, reason FROM intel_history_retractions
        ORDER BY retractedAt DESC, rowid DESC LIMIT ?`).all(pageSize + 1);
      return {
        records: rows.slice(0, pageSize).map((row) => ({ dedupeKey: row.dedupeKey, retractedAt: row.retractedAt, reason: row.reason })),
        partial: rows.length > pageSize,
      };
    }

    return {
      append,
      timeline,
      search,
      retract,
      restore,
      listRetractions,
      close() { db.close(); },
    };
  } catch (error) {
    db.close();
    throw error;
  }
}
