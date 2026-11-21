import type {
  GetWorldOverviewSnapshotRequest,
  GetWorldOverviewSnapshotResponse,
  ServerContext,
  WorldOverviewSnapshot,
} from '../../../../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { addDays, annotateWrongMarks, kstDate, WORLD_OVERVIEW_KEYS } from '../../../../shared/world-overview.js';
import { getCachedJson } from '../../../_shared/redis';

type OverviewData = WorldOverviewSnapshot & { availableDates?: string[] };
export interface SnapshotReadDeps {
  readJson(key: string): Promise<unknown | null>;
  now(): number;
}
const redisDeps: SnapshotReadDeps = { readJson: (key) => getCachedJson(key, true), now: () => Date.now() };

export async function getWorldOverviewSnapshot(
  _ctx: ServerContext,
  req: GetWorldOverviewSnapshotRequest,
  deps: SnapshotReadDeps = redisDeps,
): Promise<GetWorldOverviewSnapshotResponse> {
  const today = kstDate(deps.now());
  const date = req.date || today;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || addDays(date, 0) !== date) {
    throw Object.assign(new Error('INVALID_DATE'), { statusCode: 400 });
  }

  const key = date === today ? WORLD_OVERVIEW_KEYS.snapshot : `${WORLD_OVERVIEW_KEYS.archivePrefix}${date}`;
  const [rawSnapshot, marks, dates] = await Promise.all([
    deps.readJson(key),
    deps.readJson(WORLD_OVERVIEW_KEYS.marks),
    deps.readJson(WORLD_OVERVIEW_KEYS.dates),
  ]);
  if (!rawSnapshot || typeof rawSnapshot !== 'object') {
    throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
  }

  const snapshot = rawSnapshot as OverviewData;
  const annotated = annotateWrongMarks(snapshot as never, marks as never);
  const archivedDates = Array.isArray(dates)
    ? dates.filter((item): item is string => typeof item === 'string' && item < today).sort()
    : (snapshot.availableDates ?? []).filter((item) => item < today).sort();
  return { snapshot: annotated as unknown as WorldOverviewSnapshot, archivedDates };
}
