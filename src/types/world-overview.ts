// View-model types for the world-overview first screen (plan 2026-11-22-world-first-screen).
// Data shapes come from shared/world-overview.d.ts; these are what the map and the
// first-screen components render.
import type {
  WorldField,
  RelationKind,
  TrendState,
  SourceLink,
  MarkAnnotation,
  ConflictLevel,
} from '../../shared/world-overview';

export type { WorldField, RelationKind, TrendState, SourceLink, MarkAnnotation, ConflictLevel };

/** Choropleth step. 4 = war, 3 = high, 2 = medium, 1 = tension or issue, 0 = calm. */
export type FillLevel = 0 | 1 | 2 | 3 | 4;

export type ThemeName = 'light' | 'dark';

export interface WorldCountryView {
  iso2: string;
  /** null when the military field is off (no fill drawn). */
  level: FillLevel | null;
  /** Politics field: CII unrest outline. */
  unrestOutline: boolean;
  /** Diplomacy field: multilateral bloc ids whose outline this country gets. */
  blocIds: string[];
}

export interface WorldLineView {
  id: string;
  origin: 'fixed' | 'ai';
  kind: RelationKind;
  field: WorldField;
  from: string;
  to: string;
  /** [longitude, latitude] */
  fromCoord: [number, number];
  toCoord: [number, number];
  directed: boolean;
  trend: TrendState | null;
  /** rising or surging */
  worsening: boolean;
  /** easing */
  easing: boolean;
  /** Draw the ▲/▼ tag (top 6 by default, every worsening/easing line of the selected country). */
  showTag: boolean;
  label: string;
  reappeared: boolean;
}

export interface WorldMapView {
  date: string;
  countries: Record<string, WorldCountryView>;
  lines: WorldLineView[];
  /** Diplomacy field only; colorIndex picks from WORLD_BLOC_COLORS. */
  blocOutlines: Array<{ blocId: string; members: string[]; colorIndex: number }>;
  selectedIso2: string | null;
  /** Countries connected to the selection; everything else is dimmed to 0.36 when a country is selected. */
  relatedIso2: string[];
}

export interface TickerItem {
  id: string;
  label: string;
  value: number | null;
  changePct: number | null;
  /** Decimal places to render. */
  digits: number;
  unit?: string;
}

export interface DrawerRelation {
  id: string;
  counterpartIso2: string;
  counterpartName: string;
  kind: RelationKind;
  field: WorldField;
  origin: 'fixed' | 'ai';
  /** 'out' = this country → counterpart, 'in' = counterpart → this country, 'both' = undirected. */
  direction: 'out' | 'in' | 'both';
  label: string;
  trend: TrendState | null;
  sources: SourceLink[];
  mark?: MarkAnnotation;
}

export interface CountryDrawerData {
  iso2: string;
  nameKo: string;
  nameEn: string;
  level: FillLevel | null;
  conflictLevel: ConflictLevel | null;
  ciiScore: number | null;
  updatedAt: number;
  issue: { summaryKo: string; sources: SourceLink[]; mark?: MarkAnnotation } | null;
  relations: DrawerRelation[];
  blocs: Array<{ id: string; nameKo: string }>;
  /** Marks may only be set on today's snapshot. */
  isToday: boolean;
  aiStatus: 'ok' | 'stale' | 'missing';
}

export type WorldMarkRequest =
  | { itemKind: 'relation'; itemKey: string; action: 'mark' }
  | { itemKind: 'issue'; itemKey: string; action: 'mark' }
  | { action: 'unmark'; markId: string };

export type WorldLoadState = 'loading' | 'ok' | 'empty' | 'error';
