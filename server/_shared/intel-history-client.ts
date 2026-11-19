/**
 * Store reader for the historical intelligence memory (#5694).
 *
 * Shared by the three Pro-gated RPCs in
 * server/worldmonitor/intelligence/v1/{search-intel-history,get-intel-timeline,
 * get-similar-events}.ts. Owns one concern: reading the local SQLite history
 * store (shared/intel-history-store.mjs) that the collectors append to, and
 * adapting stored records to the wire shape. Query embedding lives in
 * ./intel-history-embed.ts — a different upstream with its own budget and
 * failure mode.
 *
 * Every function returns `null` rather than throwing, so a store failure
 * surfaces as `upstream_unavailable: true` on a 200 — the gateway reads that
 * flag out of the body and drops the response to Cache-Control: no-store
 * (server/_shared/cache-contract.ts) instead of pinning a false-empty result
 * for the cache tier's full TTL. The one exception is an invalid timeline
 * cursor, which is the caller's error and throws a ValidationError.
 */

import { ValidationError } from '../../src/generated/server/worldmonitor/intelligence/v1/service_server';
import type { IntelHistoryStore } from '../../shared/intel-history-store.mjs';

type ReadStore = Pick<IntelHistoryStore, 'timeline' | 'search'>;

/**
 * One read-only connection per process, opened on first use. Loaded lazily so
 * modules that only need the normalizers below (the MCP registry) never load
 * node:sqlite. A failed open is not cached: the database may simply not exist
 * until the first collector run, and the next request retries.
 */
let storePromise: Promise<ReadStore> | null = null;

function getStore(): Promise<ReadStore> {
  if (!storePromise) {
    storePromise = import('../../shared/intel-history-store.mjs')
      .then(({ openIntelHistoryStore, resolveIntelHistoryDbPath }) =>
        openIntelHistoryStore(resolveIntelHistoryDbPath(process.env), { readOnly: true }))
      .catch((err: unknown) => {
        storePromise = null;
        throw err;
      });
  }
  return storePromise;
}

/** Test seam: serve reads from `store` instead of the database (null resets). */
export function setIntelHistoryStoreForTests(store: ReadStore | null): void {
  storePromise = store ? Promise.resolve(store) : null;
}

/** Scope normalizers live in a dependency-free module so Edge code can use them. */
export { normalizeCountry, normalizeDomain } from './intel-history-scope';

/**
 * Scope accepted by both reads. Absent fields are omitted from the store
 * arguments entirely, and the timeline rejects an unscoped read.
 */
export interface IntelHistoryScope {
  domain?: string;
  country?: string;
  from?: number;
  to?: number;
  limit: number;
}

/** One record as the store's projection emits it. */
interface WireRecord {
  id?: unknown;
  domain?: unknown;
  resource?: unknown;
  country?: unknown;
  category?: unknown;
  title?: unknown;
  summary?: unknown;
  sourceUrl?: unknown;
  occurredAt?: unknown;
  ingestedAt?: unknown;
  score?: unknown;
}

/**
 * Structural mirror of the generated `IntelHistoryRecord` (proto
 * intel_history_record.proto). Declared here rather than imported so this
 * module stays independent of src/generated; the handlers assign these into
 * the generated response types, so any proto field change fails typecheck at
 * the call sites.
 */
export interface IntelHistoryRecordView {
  id: string;
  domain: string;
  resource: string;
  country: string;
  category: string;
  title: string;
  summary: string;
  sourceUrl: string;
  occurredAt: number;
  ingestedAt: number;
  score: number;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Adapt one stored record to the wire shape. `score` is present only on the
 * vector path; a chronological read leaves it 0, which the proto documents as
 * "no similarity applies" rather than "no similarity".
 */
function toIntelHistoryRecord(raw: WireRecord): IntelHistoryRecordView {
  return {
    id: str(raw.id),
    domain: str(raw.domain),
    resource: str(raw.resource),
    country: str(raw.country),
    category: str(raw.category),
    title: str(raw.title),
    summary: str(raw.summary),
    sourceUrl: str(raw.sourceUrl),
    occurredAt: num(raw.occurredAt),
    ingestedAt: num(raw.ingestedAt),
    score: num(raw.score),
  };
}

/**
 * Resolve a request limit: the server-side default when omitted or <= 0,
 * otherwise the requested value capped at the route's ceiling. The ceilings
 * mirror the clamps in the store, so a caller never receives fewer rows than
 * the API documents without an explanation.
 */
export function resolveLimit(requested: unknown, fallback: number, max: number): number {
  const value = Number(requested);
  return Number.isFinite(value) && value > 0 ? Math.min(Math.floor(value), max) : fallback;
}

/**
 * Drop empty scope fields so the store sees them as absent.
 *
 * `0` means "no bound" per the published contract, so it is omitted rather
 * than sent. Any other finite value is forwarded verbatim — including a
 * negative, which is a legitimate pre-1970 epoch bound and which the MCP tool
 * layer explicitly forwards on the promise that the store is the sole
 * authority on bounds. Silently discarding it here would break that promise.
 */
function scopeArgs(scope: IntelHistoryScope): IntelHistoryScope {
  const args: IntelHistoryScope = { limit: scope.limit };
  if (scope.domain) args.domain = scope.domain;
  if (scope.country) args.country = scope.country;
  if (typeof scope.from === 'number' && Number.isFinite(scope.from) && scope.from !== 0) {
    args.from = scope.from;
  }
  if (typeof scope.to === 'number' && Number.isFinite(scope.to) && scope.to !== 0) {
    args.to = scope.to;
  }
  return args;
}

const isStoreCursorError = (err: unknown): boolean =>
  err instanceof Error && err.name === 'ValidationError' && (err as { field?: unknown }).field === 'cursor';

/**
 * Run one store read. Returns null when the database cannot be opened, the
 * read throws, or the result is malformed — the caller turns that into
 * `upstream_unavailable`.
 */
async function readIntelHistory(
  operation: 'timeline' | 'search',
  read: (store: ReadStore) => { records?: unknown; partial?: unknown; nextCursor?: unknown },
): Promise<{ records: IntelHistoryRecordView[]; partial: boolean; nextCursor?: string | null } | null> {
  try {
    const body = read(await getStore());
    if (!Array.isArray(body?.records)) {
      console.warn(`[intel-history] ${operation} returned no records array`);
      return null;
    }
    return {
      records: (body.records as WireRecord[])
        .filter((rec): rec is WireRecord => rec !== null && typeof rec === 'object')
        .map(toIntelHistoryRecord),
      partial: body.partial === true,
      ...(typeof body.nextCursor === 'string' || body.nextCursor === null
        ? { nextCursor: body.nextCursor as string | null }
        : {}),
    };
  } catch (err) {
    if (isStoreCursorError(err)) {
      throw new ValidationError([{ field: 'cursor', description: 'Invalid cursor. Restart from the first page with unchanged filters.' }]);
    }
    // A store failure surfaces to the caller as an empty 200, so it has to
    // reach Sentry to be distinguishable from "no history".
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[intel-history] ${operation} failed: ${msg}`);
    return null;
  }
}

/** Semantic read: rank stored history against a query vector. */
export async function intelHistorySearch(
  params: IntelHistoryScope & { embedding: number[]; minScore?: number },
): Promise<{ records: IntelHistoryRecordView[]; partial: boolean } | null> {
  const { embedding, minScore, ...scope } = params;
  const result = await readIntelHistory('search', (store) => store.search({
    vector: embedding,
    ...scopeArgs(scope),
    ...(typeof minScore === 'number' ? { minScore } : {}),
  }));
  return result && { records: result.records, partial: result.partial };
}

/**
 * Chronological read. At least one of domain/country must be set — the caller
 * enforces that and returns 400, because the store answers an unscoped read
 * with an error that this layer could only report as an outage.
 */
export async function intelHistoryTimeline(
  scope: IntelHistoryScope & { cursor?: string },
): Promise<{ records: IntelHistoryRecordView[]; partial: boolean; nextCursor: string } | null> {
  const result = await readIntelHistory('timeline', (store) => store.timeline({
    ...scopeArgs(scope), ...(scope.cursor ? { cursor: scope.cursor } : {}),
  }));
  // A reader that cannot say whether more pages exist cannot prove that a
  // bounded page exhausts history.
  if (!result || result.nextCursor === undefined) return null;
  return { records: result.records, partial: result.partial, nextCursor: result.nextCursor ?? '' };
}
