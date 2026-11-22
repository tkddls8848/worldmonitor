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
  /** Ops room: conflict hotspots to mark on the map (at most 5); empty when the military field is off. */
  hotspots: MapHotspot[];
}

export interface TickerItem {
  id: string;
  label: string;
  value: number | null;
  changePct: number | null;
  changeKind?: 'pct' | 'abs' | 'bp';
  /** Positive values move in the adverse direction (shown in red/down style). */
  inverse?: boolean;
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
  outages: Array<{ id: string; start: number; end: number | null; severity: 'low' | 'medium' | 'high'; signals: string[]; url: string }>;
}

export type WorldMarkRequest =
  | { itemKind: 'relation'; itemKey: string; action: 'mark' }
  | { itemKind: 'issue'; itemKey: string; action: 'mark' }
  | { action: 'unmark'; markId: string };

export type WorldLoadState = 'loading' | 'ok' | 'empty' | 'error';

// ---- Ops room (battle board) additions, plan 2026-11-22-ops-room ----

/** DEFCON-style global threat level: 1 = most severe, 5 = calm. */
export type ThreatLevel = 1 | 2 | 3 | 4 | 5;

export interface OpsCounters {
  /** Countries at fill level 4 (war). */
  wars: number;
  /** Countries at fill level 3 (high-intensity conflict). */
  highConflicts: number;
  /** Visible + listed relations whose trend is rising or surging. */
  worsening: number;
  /** Sanction relation lines (directed issuer → target pairs). */
  sanctionPairs: number;
  /** AI-extracted relations in today's snapshot. */
  aiRelations: number;
  /** Breaking alerts received in the last 24 h. */
  breaking24h: number;
  /** Active or ended within the last six hours. */
  outages: number;
}

export interface OpsMetrics {
  threatLevel: ThreatLevel;
  /** 0–100 score behind the level (higher = more severe). */
  threatScore: number;
  counters: OpsCounters;
}

export type OpsEventSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface OpsEvent {
  id: string;
  /** epoch ms */
  at: number;
  kind: 'breaking' | 'relation' | 'issue' | 'outage';
  title: string;
  iso2?: string;
  severity: OpsEventSeverity;
  url?: string;
}

export interface MapHotspot {
  iso2: string;
  /** [longitude, latitude] */
  coord: [number, number];
  level: FillLevel;
}
