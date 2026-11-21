export type WorldField = 'military' | 'diplomacy' | 'geopolitics' | 'politics' | 'finance';
export type RelationKind = 'support' | 'sanction' | 'alliance' | 'tension' | 'economic';
export type ConflictLevel = 'war' | 'high' | 'medium' | 'tension';
export type CountryFill = ConflictLevel | 'issue' | null;
export type TrendState = 'collecting' | 'steady' | 'rising' | 'easing' | 'surging';
export interface SourceLink { url: string; title: string; publisher: string; publishedAt?: number }
export interface PairTrend { state: TrendState; recentEventsPerDay: number; baselineEventsPerDay: number | null; recentIntensityPerDay: number; baselineIntensityPerDay: number | null; ratio: number | null; trackedSince: number }
export interface MarkAnnotation { state: 'hidden' | 'reappeared'; markId: string; markedAt: number }
export interface RelationLine {
  id: string; origin: 'fixed' | 'ai'; kind: RelationKind; basis?: 'trade' | 'bank'; field: WorldField;
  from: string; to: string; directed: boolean; score: number; value: number; label: string;
  confidence?: number; sources: SourceLink[]; trend: PairTrend | null; mark?: MarkAnnotation;
}
export interface CountryIssue { summaryKo: string; fields: WorldField[]; sources: SourceLink[]; mark?: MarkAnnotation }
export interface CountryState {
  level: ConflictLevel | null; deaths: { count: number; source: 'ucdp' | 'hapi'; month: string } | null;
  cii: { score: number; unrest: number } | null; demonstrations: number | null; unrest: boolean;
  blocs: string[]; inNews: boolean; issue: CountryIssue | null;
}
export interface Bloc { id: string; nameKo: string; nameEn: string; members: string[]; source: SourceLink }
export interface InputStatus { status: 'ok' | 'stale' | 'missing'; asOf: number | null }
export interface WorldOverviewSnapshot {
  schemaVersion: 1; date: string; generatedAt: number; countries: Record<string, CountryState>; relations: RelationLine[];
  blocs: Bloc[]; anchors: Record<string, [number, number]>; ai: { status: 'ok' | 'stale' | 'missing'; date: string | null; model: string | null };
  inputs: Record<'relations' | 'trends' | 'ai' | 'ucdp' | 'hapi' | 'cii' | 'news', InputStatus>; availableDates: string[];
}
export interface WrongMark { id: string; type: 'relation' | 'issue'; date: string; matchKey?: string; iso2?: string; sourceUrls: string[]; summaryKo: string; markedAt: number; undoneAt?: number }
export interface WrongMarksDoc { marks: WrongMark[]; updatedAt: number }
export type MarkAction =
  | { action: 'mark'; date: string; target: { type: 'relation'; relationId: string } | { type: 'issue'; iso2: string } }
  | { action: 'unmark'; markId: string };
export const WORLD_OVERVIEW_TIMEZONE: 'Asia/Seoul';
export const WORLD_OVERVIEW_KEYS: Readonly<{ relations: 'world-overview:relations:v1'; pairTrends: 'gdelt:bulk:world-pair-trends:v1'; ai: 'world-overview:ai:v1'; snapshot: 'world-overview:snapshot:v1'; archivePrefix: 'world-overview:snapshot:v1:'; dates: 'world-overview:snapshot-dates:v1'; marks: 'world-overview:wrong-marks:v1' }>;
export function kstDate(nowMs: number): string;
export function kstHour(nowMs: number): number;
export function addDays(date: string, days: number): string;
export function pairKey(a: string, b: string): string;
export const LINE_BUDGET: 30;
export const DEFAULT_FIELDS: readonly WorldField[];
export const WORLD_FIELDS: readonly WorldField[];
export const MARK_HIDE_DAYS: 14;
export const MARK_REAPPEAR_MIN_NEW_SOURCES: 2;
export const MARK_RETENTION_DAYS: 400;
export const AI_DISCLAIMER_KO: 'AI가 뉴스로 만든 요약이며 틀릴 수 있다';
export const FIELD_LABEL_KO: Readonly<Record<WorldField, string>>;
export const KIND_LABEL_KO: Readonly<Record<RelationKind, string>>;
export const LEVEL_LABEL_KO: Readonly<Record<ConflictLevel | 'issue', string>>;
export const TREND_LABEL_KO: Readonly<Record<TrendState, string>>;
export function isDrawableEndpoint(code: string, anchors: Record<string, [number, number]>): boolean;
export function selectVisibleLines(snapshot: WorldOverviewSnapshot, enabledFields: readonly WorldField[], budget?: number): RelationLine[];
export function countryFill(country: CountryState): CountryFill;
export function annotateWrongMarks(snapshot: WorldOverviewSnapshot, doc: WrongMarksDoc | null): WorldOverviewSnapshot;
export function applyMarkAction(doc: WrongMarksDoc | null, action: MarkAction, snapshot: WorldOverviewSnapshot | null, nowMs: number):
  | { ok: true; doc: WrongMarksDoc; mark: WrongMark }
  | { ok: false; error: 'TARGET_NOT_FOUND' | 'NOT_MARKABLE' | 'MARK_NOT_FOUND' };
