import type {
  ServerContext,
  SetWorldOverviewMarkRequest,
  SetWorldOverviewMarkResponse,
  WorldOverviewSnapshot,
} from '../../../../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { applyMarkAction, annotateWrongMarks, kstDate, WORLD_OVERVIEW_KEYS } from '../../../../shared/world-overview.js';
import { getCachedEnvelopeJson, getCachedJson, setCachedJson } from '../../../_shared/redis';

const WRONG_MARKS_TTL_SECONDS = 34_560_000;
const TODAY_SNAPSHOT_TTL_SECONDS = 172_800;

interface SeedEnvelope { _seed?: unknown; data?: unknown }
export interface MarkWriteDeps {
  readJson(key: string): Promise<unknown | null>;
  readEnvelope(key: string): Promise<unknown | null>;
  writeJson(key: string, value: unknown, ttlSeconds: number): Promise<boolean>;
  now(): number;
}
const redisDeps: MarkWriteDeps = {
  readJson: (key) => getCachedJson(key, true),
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
  const [rawMarks, envelope] = await Promise.all([
    deps.readJson(WORLD_OVERVIEW_KEYS.marks),
    deps.readEnvelope(WORLD_OVERVIEW_KEYS.snapshot),
  ]);
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
    if (!snapshot || snapshot.date !== today) fail('TARGET_NOT_FOUND', 404);
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
    const updated = annotateWrongMarks(snapshot as never, result.doc as never);
    const value = wrapped ? { ...wrapped, data: updated } : updated;
    if (!await deps.writeJson(WORLD_OVERVIEW_KEYS.snapshot, value, TODAY_SNAPSHOT_TTL_SECONDS)) {
      fail('STORE_FAILED', 503);
    }
  } else if (action.action === 'unmark' && snapshot?.date === today) {
    const updated = annotateWrongMarks(snapshot as never, result.doc as never);
    const value = wrapped ? { ...wrapped, data: updated } : updated;
    if (!await deps.writeJson(WORLD_OVERVIEW_KEYS.snapshot, value, TODAY_SNAPSHOT_TTL_SECONDS)) {
      fail('STORE_FAILED', 503);
    }
  }
  return { ok: true, mark: result.mark as SetWorldOverviewMarkResponse['mark'] };
}
