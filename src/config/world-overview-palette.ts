// Map colours for the world-overview first screen, from the approved Antigravity design
// (.personal/argus-style-mockups/FINAL-SPEC-OPTION-A.md §2.3-2.5). CSS tokens for the
// chrome live in src/styles/world-first-screen.css.
import type { FillLevel, RelationKind, ThemeName, WorldField } from '@/types/world-overview';

type Rgba = [number, number, number, number];

function hex(h: string, a = 255): Rgba {
  const n = Number.parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255, a];
}

export const WORLD_FILL_COLORS: Record<ThemeName, Record<FillLevel | 'none', Rgba>> = {
  light: { 0: hex('#F3F4EF'), 1: hex('#D5DFD8'), 2: hex('#EBD296'), 3: hex('#DF884B'), 4: hex('#B8293D'), none: hex('#E6EBE8') },
  dark: { 0: hex('#171E1B'), 1: hex('#23302B'), 2: hex('#6D5729'), 3: hex('#A84E24'), 4: hex('#C82E43'), none: hex('#131916') },
};

export const WORLD_OCEAN: Record<ThemeName, Rgba> = { light: hex('#DCE5E4'), dark: hex('#0B0E0D') };
export const WORLD_LAND_STROKE: Record<ThemeName, Rgba> = { light: hex('#B4C0BC'), dark: hex('#0B0E0D') };
export const WORLD_LAND_STROKE_WIDTH = { base: 0.7, hover: 1.45, selected: 2.2 } as const;
export const WORLD_DIM_OPACITY = 0.36;
export const WORLD_LAND_HOVER_STROKE: Record<ThemeName, Rgba> = { light: hex('#182628'), dark: hex('#E8EFEA') };
export const WORLD_LAND_SELECTED_STROKE: Record<ThemeName, Rgba> = { light: hex('#1D4ED8'), dark: hex('#F3C159') };

/** economic: violet dash-dot with diamond ends (FINAL-SPEC-OPTION-A appendix 2). */
export const WORLD_RELATION_COLORS: Record<ThemeName, Record<RelationKind, Rgba>> = {
  light: { support: hex('#0F766E'), sanction: hex('#B45309'), alliance: hex('#1D4ED8'), tension: hex('#BE123C'), economic: hex('#6D28D9') },
  dark: { support: hex('#2DD4BF'), sanction: hex('#F59E0B'), alliance: hex('#60A5FA'), tension: hex('#FB7185'), economic: hex('#A78BFA') },
};

export const WORLD_ARC_CASING: Record<ThemeName, Rgba> = {
  light: [248, 249, 246, Math.round(0.82 * 255)],
  dark: [11, 14, 13, 204],
};

/** Dash arrays (on, off, on, off, ...) in px; null = solid. */
export const WORLD_RELATION_DASH: Record<RelationKind, readonly number[] | null> = {
  support: null, sanction: [6.5, 4.2], alliance: null, tension: [2.2, 4.2], economic: [9, 3.2, 2, 3.2],
};

export const WORLD_RELATION_END: Record<RelationKind, 'arrow' | 'bar' | 'dots' | 'double-arrow' | 'diamond'> = {
  support: 'arrow', sanction: 'bar', alliance: 'dots', tension: 'double-arrow', economic: 'diamond',
};

/** Width/opacity by trend: worsening / steady (incl. collecting, null) / easing. Alliance adds ALLIANCE_EXTRA_WIDTH. */
export const WORLD_TREND_STROKE = {
  worsening: { width: 2.25, opacity: 0.96 },
  steady: { width: 1.65, opacity: 0.82 },
  easing: { width: 1.45, opacity: 0.72 },
} as const;
export const ALLIANCE_EXTRA_WIDTH = 0.8;

export const WORLD_FIELD_ACCENT: Record<WorldField, string> = {
  military: '#BE123C', diplomacy: '#1D4ED8', geopolitics: '#6D28D9', politics: '#B45309', finance: '#0F766E',
};

/** Bloc outline colours for the diplomacy field (NATO, CSTO, SCO, ...), cycled by colorIndex. */
export const WORLD_BLOC_COLORS: Record<ThemeName, Rgba[]> = {
  light: [hex('#1D4ED8'), hex('#6D28D9'), hex('#0F766E'), hex('#B45309'), hex('#BE185D')],
  dark: [hex('#60A5FA'), hex('#A78BFA'), hex('#2DD4BF'), hex('#FBBF24'), hex('#F472B6')],
};
export const WORLD_UNREST_OUTLINE: Record<ThemeName, Rgba> = { light: hex('#B45309'), dark: hex('#FBBF24') };

/** Tactical map marks; values are intentionally centralized for the ops-room theme pass. */
export const WORLD_HOTSPOT_COLORS: Record<ThemeName, Rgba> = {
  light: hex('#B8293D'), dark: hex('#FB7185'),
};
export const WORLD_TARGET_COLOR: Record<ThemeName, Rgba> = {
  light: hex('#8F2633'), dark: hex('#F3C159'),
};
export const WORLD_GRID_COLOR: Record<ThemeName, Rgba> = {
  light: hex('#60716C', 36), dark: hex('#9AB8A8', 22),
};

export const WORLD_TAG_MAX_DEFAULT = 6;
