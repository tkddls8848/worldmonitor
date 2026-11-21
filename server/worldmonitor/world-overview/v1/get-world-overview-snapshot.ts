import type {
  GetWorldOverviewSnapshotRequest,
  GetWorldOverviewSnapshotResponse,
  ServerContext,
  WorldOverviewSnapshot,
} from '../../../../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { addDays, annotateWrongMarks, kstDate, WORLD_OVERVIEW_KEYS } from '../../../../shared/world-overview.js';
import { getCachedJson } from '../../../_shared/redis';

type StoredOverviewData = import('../../../../shared/world-overview.js').WorldOverviewSnapshot;
export interface SnapshotReadDeps {
  readJson(key: string): Promise<unknown | null>;
  now(): number;
}
const redisDeps: SnapshotReadDeps = { readJson: (key) => getCachedJson(key, true), now: () => Date.now() };

function toRpcSnapshot(data: StoredOverviewData): WorldOverviewSnapshot {
  const countries = Object.fromEntries(Object.entries(data.countries).map(([iso2, country]) => [iso2, {
    level: country.level ?? '',
    ...(country.deaths ? { deaths: country.deaths } : {}),
    ...(country.cii ? { cii: country.cii } : {}),
    demonstrations: country.demonstrations ?? 0,
    hasDemonstrations: country.demonstrations != null,
    unrest: country.unrest,
    blocs: country.blocs,
    inNews: country.inNews,
    ...(country.issue ? { issue: country.issue } : {}),
  }]));
  const relations = data.relations.map(({ trend, ...line }) => ({
    ...line,
    basis: line.basis ?? '',
    confidence: line.confidence ?? 0,
    hasConfidence: line.confidence != null,
    ...(trend ? { trend: {
      ...trend,
      baselineEventsPerDay: trend.baselineEventsPerDay ?? 0,
      hasBaselineEventsPerDay: trend.baselineEventsPerDay != null,
      baselineIntensityPerDay: trend.baselineIntensityPerDay ?? 0,
      hasBaselineIntensityPerDay: trend.baselineIntensityPerDay != null,
      ratio: trend.ratio ?? 0,
      hasRatio: trend.ratio != null,
    } } : {}),
  }));
  return {
    schemaVersion: data.schemaVersion, date: data.date, generatedAt: data.generatedAt, countries, relations,
    blocs: data.blocs, anchors: Object.fromEntries(Object.entries(data.anchors).map(([key, [longitude, latitude]]) => [key, { longitude, latitude }])),
    ...(data.ai ? { ai: { status: data.ai.status, date: data.ai.date ?? '', model: data.ai.model ?? '' } } : {}),
    inputs: Object.fromEntries(Object.entries(data.inputs).map(([key, input]) => [key, {
      status: input.status, ...(input.asOf == null ? {} : { asOf: input.asOf }),
    }])),
    availableDates: data.availableDates,
  };
}

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
  let selected = rawSnapshot;
  if (date === today && (!selected || typeof selected !== 'object' || (selected as StoredOverviewData).date !== today)) {
    selected = await deps.readJson(`${WORLD_OVERVIEW_KEYS.archivePrefix}${addDays(today, -1)}`);
  }
  if (!selected || typeof selected !== 'object') {
    throw Object.assign(new Error('NOT_FOUND'), { statusCode: 404 });
  }

  const snapshot = selected as StoredOverviewData;
  const annotated = annotateWrongMarks(snapshot as never, marks as never);
  const archivedDates = Array.isArray(dates)
    ? dates.filter((item): item is string => typeof item === 'string' && item < today).sort()
    : (snapshot.availableDates ?? []).filter((item) => item < today).sort();
  return { snapshot: toRpcSnapshot(annotated as StoredOverviewData), archivedDates };
}
