import type { WorldOverviewSnapshot as Snapshot, CountryState, RelationLine, Bloc } from '../../shared/world-overview.js';
import type { WorldMarkRequest } from '@/types/world-overview';
import type { WorldOverviewSnapshot as RpcSnapshot } from '@/generated/client/worldmonitor/world_overview/v1/service_client';
import { WorldOverviewServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';
import { ensureHydrated } from '@/services/bootstrap';

const client = new WorldOverviewServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });
const inputNames = ['relations', 'trends', 'ai', 'ucdp', 'hapi', 'cii', 'news'] as const;
const isRecord = (value: unknown): value is Record<string, any> => !!value && typeof value === 'object' && !Array.isArray(value);
const enumValue = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T => allowed.includes(value as T) ? value as T : fallback;
const fields = ['military', 'diplomacy', 'geopolitics', 'politics', 'finance'] as const;
const kinds = ['support', 'sanction', 'alliance', 'tension', 'economic'] as const;
const trends = ['collecting', 'steady', 'rising', 'easing', 'surging'] as const;
const sourceLinks = (value: unknown) => Array.isArray(value) ? value.filter(isRecord).map((s) => ({ url: String(s.url ?? ''), title: String(s.title ?? ''), publisher: String(s.publisher ?? ''), ...(typeof s.publishedAt === 'number' ? { publishedAt: s.publishedAt } : {}) })) : [];
const mark = (value: unknown) => isRecord(value) && typeof value.markId === 'string' ? { state: enumValue(value.state, ['hidden', 'reappeared'] as const, 'hidden'), markId: value.markId, markedAt: Number(value.markedAt) || 0 } : undefined;

function normalizeCountry(raw: unknown): CountryState | null {
  if (!isRecord(raw)) return null;
  const deaths = isRecord(raw.deaths) ? { count: Number(raw.deaths.count) || 0, source: enumValue(raw.deaths.source, ['ucdp', 'hapi'] as const, 'ucdp'), month: String(raw.deaths.month ?? '') } : null;
  const cii = isRecord(raw.cii) ? { score: Number(raw.cii.score) || 0, unrest: Number(raw.cii.unrest) || 0 } : null;
  const issueRaw = raw.issue;
  const issue = isRecord(issueRaw) ? { summaryKo: String(issueRaw.summaryKo ?? ''), fields: (Array.isArray(issueRaw.fields) ? issueRaw.fields : []).filter((f: unknown) => fields.includes(f as typeof fields[number])), sources: sourceLinks(issueRaw.sources), ...(mark(issueRaw.mark) ? { mark: mark(issueRaw.mark) } : {}) } : null;
  return {
    level: typeof raw.level === 'string' && ['war', 'high', 'medium', 'tension'].includes(raw.level) ? raw.level as CountryState['level'] : null, deaths, cii,
    demonstrations: typeof raw.demonstrations === 'number' && (raw.hasDemonstrations !== false) ? raw.demonstrations : null,
    unrest: raw.unrest === true, blocs: Array.isArray(raw.blocs) ? raw.blocs.filter((v: unknown) => typeof v === 'string') : [],
    inNews: raw.inNews === true, issue,
  };
}

function normalizeRelation(raw: unknown): RelationLine | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.from !== 'string' || typeof raw.to !== 'string') return null;
  const trendRaw = isRecord(raw.trend) ? raw.trend : null;
  const trend = trendRaw ? {
    state: enumValue(trendRaw.state, trends, 'steady'), recentEventsPerDay: Number(trendRaw.recentEventsPerDay) || 0,
    baselineEventsPerDay: trendRaw.hasBaselineEventsPerDay === false ? null : (typeof trendRaw.baselineEventsPerDay === 'number' ? trendRaw.baselineEventsPerDay : null),
    recentIntensityPerDay: Number(trendRaw.recentIntensityPerDay) || 0,
    baselineIntensityPerDay: trendRaw.hasBaselineIntensityPerDay === false ? null : (typeof trendRaw.baselineIntensityPerDay === 'number' ? trendRaw.baselineIntensityPerDay : null),
    ratio: trendRaw.hasRatio === false ? null : (typeof trendRaw.ratio === 'number' ? trendRaw.ratio : null), trackedSince: Number(trendRaw.trackedSince) || 0,
  } : null;
  return {
    id: raw.id, origin: enumValue(raw.origin, ['fixed', 'ai'] as const, 'fixed'), kind: enumValue(raw.kind, kinds, 'tension'),
    ...(raw.basis === 'trade' || raw.basis === 'bank' ? { basis: raw.basis } : {}), field: enumValue(raw.field, fields, 'geopolitics'),
    from: raw.from, to: raw.to, directed: raw.directed === true, score: Number(raw.score) || 0, value: Number(raw.value) || 0, label: String(raw.label ?? ''),
    ...(typeof raw.confidence === 'number' && raw.hasConfidence !== false ? { confidence: raw.confidence } : {}), sources: sourceLinks(raw.sources), trend,
    ...(mark(raw.mark) ? { mark: mark(raw.mark) } : {}),
  };
}

export function normalizeWorldSnapshot(raw: unknown): Snapshot | null {
  if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.date !== 'string' || !isRecord(raw.countries) || !isRecord(raw.anchors)) return null;
  const countries: Record<string, CountryState> = {};
  for (const [iso2, value] of Object.entries(raw.countries)) { const country = normalizeCountry(value); if (country) countries[iso2] = country; }
  const anchors: Record<string, [number, number]> = {};
  for (const [iso2, value] of Object.entries(raw.anchors)) {
    const coords = Array.isArray(value) ? value : isRecord(value) ? [value.longitude, value.latitude] : null;
    if (coords && coords.length >= 2 && Number.isFinite(Number(coords[0])) && Number.isFinite(Number(coords[1]))) anchors[iso2] = [Number(coords[0]), Number(coords[1])];
  }
  const inputs = {} as Snapshot['inputs'];
  for (const name of inputNames) {
    const value = isRecord(raw.inputs) && isRecord(raw.inputs[name]) ? raw.inputs[name] : {};
    inputs[name] = { status: enumValue(value.status, ['ok', 'stale', 'missing'] as const, 'missing'), asOf: typeof value.asOf === 'number' ? value.asOf : null };
  }
  const blocs: Bloc[] = (Array.isArray(raw.blocs) ? raw.blocs : []).filter(isRecord).map((b) => ({ id: String(b.id ?? ''), nameKo: String(b.nameKo ?? ''), nameEn: String(b.nameEn ?? ''), members: Array.isArray(b.members) ? b.members.filter((x: unknown) => typeof x === 'string') : [], source: sourceLinks([b.source])[0] ?? { url: '', title: '', publisher: '' } }));
  const aiRaw = isRecord(raw.ai) ? raw.ai : {};
  return {
    schemaVersion: 1, date: raw.date, generatedAt: Number(raw.generatedAt) || 0, countries,
    relations: (Array.isArray(raw.relations) ? raw.relations : []).map(normalizeRelation).filter((r): r is RelationLine => r !== null), blocs, anchors,
    ai: { status: enumValue(aiRaw.status, ['ok', 'stale', 'missing'] as const, 'missing'), date: typeof aiRaw.date === 'string' && aiRaw.hasDate !== false ? aiRaw.date : null, model: typeof aiRaw.model === 'string' && aiRaw.hasModel !== false ? aiRaw.model : null },
    inputs, availableDates: Array.isArray(raw.availableDates) ? raw.availableDates.filter((d: unknown) => typeof d === 'string') : [],
  };
}

export async function loadWorldOverview(date?: string): Promise<{ snapshot: Snapshot | null; archivedDates: string[] }> {
  if (!date) {
    const hydrated = normalizeWorldSnapshot(await ensureHydrated('worldOverview'));
    if (hydrated) return { snapshot: hydrated, archivedDates: hydrated.availableDates };
  }
  const response = await client.getWorldOverviewSnapshot({ date: date ?? '' });
  return { snapshot: normalizeWorldSnapshot((response.snapshot ?? null) as RpcSnapshot | null), archivedDates: response.archivedDates ?? [] };
}

export async function setWorldMark(req: WorldMarkRequest): Promise<{ ok: boolean }> {
  const body = req.action === 'unmark'
    ? { itemKind: '', itemKey: '', action: 'unmark', markId: req.markId }
    : { itemKind: req.itemKind, itemKey: req.itemKey, action: 'mark', markId: '' };
  const response = await client.setWorldOverviewMark(body);
  return { ok: response.ok === true };
}
