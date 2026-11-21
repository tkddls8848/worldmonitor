import type {
  ServerContext,
  SetWorldOverviewMarkRequest,
  SetWorldOverviewMarkResponse,
  WorldOverviewSnapshot,
} from '../../../../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { applyMarkAction, annotateWrongMarks, kstDate, WORLD_OVERVIEW_KEYS } from '../../../../shared/world-overview.js';
import { getCachedEnvelopeJson, getCachedJson, readCachedJson, setCachedJson, type CacheReadResult } from '../../../_shared/redis';

const WRONG_MARKS_TTL_SECONDS = 34_560_000;
const TODAY_SNAPSHOT_TTL_SECONDS = 172_800;

interface SeedEnvelope { _seed?: unknown; data?: unknown }
export interface MarkWriteDeps {
  readJson(key: string): Promise<unknown | null>;
  readMarks(): Promise<CacheReadResult>;
  readEnvelope(key: string): Promise<unknown | null>;
  writeJson(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  now(): number;
}
const redisDeps: MarkWriteDeps = {
  readJson: (key) => getCachedJson(key, true),
  readMarks: () => readCachedJson(WORLD_OVERVIEW_KEYS.marks, true),
  readEnvelope: (key) => getCachedEnvelopeJson(key, true),
  writeJson: (key, value, ttl) => setCachedJson(key, value, ttl, true),
  now: () => Date.now(),
};

function fail(message: string, statusCode: number): never {
  throw Object.assign(new Error(message), { statusCode });
}

export async function setWorldOverviewMark(
  _ctx: ServerContext,
  req: SetWorldOverviewMarkRequest,
  deps: MarkWriteDeps = redisDeps,
): Promise<SetWorldOverviewMarkResponse> {
  const [marksRead, envelope] = await Promise.all([
    deps.readMarks(),
    deps.readEnvelope(WORLD_OVERVIEW_KEYS.snapshot),
  ]);
  if (marksRead.status === 'error') fail('STORE_READ_FAILED', 503);
  const rawMarks = marksRead.status === 'hit' ? marksRead.value : null;
  const marks = rawMarks && typeof rawMarks === 'object' ? rawMarks as Parameters<typeof applyMarkAction>[0] : null;
  const wrapped = envelope && typeof envelope === 'object' && 'data' in envelope
    ? envelope as SeedEnvelope
    : null;
  const rawSnapshot = wrapped?.data ?? envelope;
  const now = deps.now();
  const today = kstDate(now);
  const snapshot = rawSnapshot && typeof rawSnapshot === 'object' ? rawSnapshot as WorldOverviewSnapshot : null;

  let action: Parameters<typeof applyMarkAction>[1];
  if (req.action === 'unmark') {
    if (!req.markId) fail('INVALID_ARGUMENTS', 400);
    action = { action: 'unmark', markId: req.markId };
  } else if (req.action === 'mark' && (req.itemKind === 'relation' || req.itemKind === 'issue') && req.itemKey) {
    // Marks are date-bound to today's snapshot; the RPC has no date field by design.
    if (!snapshot || snapshot.date !== today) fail('TODAY_SNAPSHOT_NOT_READY', 404);
    action = req.itemKind === 'relation'
      ? { action: 'mark', date: snapshot.date, target: { type: 'relation', relationId: req.itemKey } }
      : { action: 'mark', date: snapshot.date, target: { type: 'issue', iso2: req.itemKey } };
  } else {
    fail('INVALID_ARGUMENTS', 400);
  }

  const result = applyMarkAction(marks as never, action, snapshot as never, now);
  if (!result.ok) {
    const status = result.error === 'NOT_MARKABLE' ? 400 : result.error === 'MARK_NOT_FOUND' ? 404 : 404;
    fail(result.error, status);
  }
  if (!await deps.writeJson(WORLD_OVERVIEW_KEYS.marks, result.doc, WRONG_MARKS_TTL_SECONDS)) {
    fail('STORE_FAILED', 503);
  }

  if (action.action === 'mark' && snapshot && snapshot.date === today) {
    await writeAnnotatedSnapshotIfCurrent(deps, snapshot, wrapped, result.doc);
  } else if (action.action === 'unmark' && snapshot?.date === today) {
    await writeAnnotatedSnapshotIfCurrent(deps, snapshot, wrapped, result.doc);
  }
  return { ok: true, mark: result.mark as SetWorldOverviewMarkResponse['mark'] };
}

async function writeAnnotatedSnapshotIfCurrent(
  deps: MarkWriteDeps,
  snapshot: WorldOverviewSnapshot,
  wrapped: SeedEnvelope | null,
  marks: Parameters<typeof annotateWrongMarks>[1],
): Promise<void> {
  // A builder publish between our initial read and this read wins; the GET
  // handler applies marks on read, so rewriting the older payload is needless.
  const latest = await deps.readEnvelope(WORLD_OVERVIEW_KEYS.snapshot);
  const latestData = latest && typeof latest === 'object' && 'data' in latest ? latest.data : latest;
  if (!latestData || typeof latestData !== 'object'
    || (latestData as WorldOverviewSnapshot).date !== snapshot.date
    || (latestData as WorldOverviewSnapshot).generatedAt !== snapshot.generatedAt) return;
  const latestWrapped = latest && typeof latest === 'object' && 'data' in latest ? latest as SeedEnvelope : wrapped;
  const updated = annotateWrongMarks(latestData as never, marks as never);
  const value = latestWrapped ? { ...latestWrapped, data: updated } : updated;
  if (!await deps.writeJson(WORLD_OVERVIEW_KEYS.snapshot, value, TODAY_SNAPSHOT_TTL_SECONDS)) fail('STORE_FAILED', 503);
}
