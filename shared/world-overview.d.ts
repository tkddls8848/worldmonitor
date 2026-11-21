export type WorldField = 'military' | 'diplomacy' | 'geopolitics' | 'politics' | 'finance';
export type LineField = Exclude<WorldField, 'politics'>;
export type AiRelationKind = 'support' | 'sanction' | 'alliance' | 'tension';
export type RelationKind = AiRelationKind | 'economic';
export const WORLD_OVERVIEW_TIMEZONE: 'Asia/Seoul';
export const WORLD_OVERVIEW_KEYS: {
  relations: 'world-overview:relations:v1'; pairTrends: 'gdelt:bulk:world-pair-trends:v1'; ai: 'world-overview:ai:v1';
  snapshot: 'world-overview:snapshot:v1'; archivePrefix: 'world-overview:snapshot:v1:'; dates: 'world-overview:snapshot-dates:v1'; marks: 'world-overview:wrong-marks:v1';
};
export function kstDate(nowMs: number): string;
export function kstHour(nowMs: number): number;
export function addDays(date: string, days: number): string;
export function pairKey(a: string, b: string): string;
export const WORLD_FIELDS: readonly WorldField[];
export const AI_RELATION_KINDS: readonly AiRelationKind[];
export const DIRECTED_KINDS: ReadonlySet<RelationKind>;
export const KIND_DEFAULT_FIELD: Readonly<Record<AiRelationKind, LineField>>;
export function relationMatchKey(r: { kind: RelationKind; from: string; to: string }): string;
