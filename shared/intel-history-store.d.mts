// Types for shared/intel-history-store.mjs (implementation: scripts/lib/intel-history-store.mjs).

export const INTEL_HISTORY_DIMS: 512;
export const INTEL_HISTORY_EMBED_MODEL: 'openai/text-embedding-3-small@512';
export const INTEL_HISTORY_RETENTION_MS: number;
export const INTEL_HISTORY_MAX_APPEND_RECORDS: number;
export const INTEL_HISTORY_MAX_RETRACT_IDENTIFIERS: number;
export const TIMELINE_MAX_LIMIT: number;
export const SEARCH_MAX_LIMIT: number;

export class ValidationError extends Error {
  constructor(field: string, message: string);
  readonly field: string;
}

export class IntelHistoryStoreError extends Error {
  constructor(code: string, message: string);
  readonly code: string;
}

/** One stored record as every read projects it (no vector). */
export interface IntelHistoryStoredRecord {
  id: string;
  domain: string;
  resource: string;
  country?: string;
  category?: string;
  title: string;
  summary?: string;
  sourceUrl?: string;
  occurredAt: number;
  ingestedAt: number;
  runId: string;
  dedupeKey: string;
}

export interface IntelHistoryAppendRecord {
  dedupeKey: string;
  title: string;
  occurredAt: number;
  embedding: ArrayLike<number>;
  country?: string;
  category?: string;
  summary?: string;
  sourceUrl?: string;
}

export interface IntelHistoryScopeArgs {
  domain?: string;
  country?: string;
  from?: number;
  to?: number;
  limit?: number;
}

export interface IntelHistoryStore {
  append(args: { domain: string; resource: string; runId: string; records: IntelHistoryAppendRecord[] }):
    { inserted: number; skipped: number; retracted: number };
  timeline(args: IntelHistoryScopeArgs & { cursor?: string }):
    { records: IntelHistoryStoredRecord[]; partial: boolean; nextCursor: string | null };
  search(args: IntelHistoryScopeArgs & { vector: ArrayLike<number>; minScore?: number }):
    { records: Array<IntelHistoryStoredRecord & { score: number }>; partial: boolean };
  retract(args: { ids?: string[]; dedupeKeys?: string[]; reason: string }): {
    retracted: number; deleted: number; tombstoned: number; refreshed: number; keys: string[]; unresolvedIds: string[];
  };
  restore(args: { dedupeKeys: string[] }): { restored: number; notRetracted: string[] };
  listRetractions(args?: { limit?: number }): {
    records: Array<{ dedupeKey: string; retractedAt: number; reason: string }>; partial: boolean;
  };
  close(): void;
}

export function resolveIntelHistoryDbPath(env?: Record<string, string | undefined>): string;

export function openIntelHistoryStore(
  filename: string,
  options?: { now?: () => number; readOnly?: boolean },
): IntelHistoryStore;
