import { countryFill, selectVisibleLines, isDrawableEndpoint } from '../../shared/world-overview.js';
import type { WorldOverviewSnapshot, CountryFill, RelationLine, TrendState } from '../../shared/world-overview.js';
import type { FillLevel, WorldField, WorldMapView, WorldLineView, CountryDrawerData, DrawerRelation } from '@/types/world-overview';
import { getCountryCentroid, getCountryPolygons } from '@/services/country-geometry';

export function fillLevelFor(fill: CountryFill): FillLevel {
  switch (fill) {
    case 'war': return 4;
    case 'high': return 3;
    case 'medium': return 2;
    case 'tension': case 'issue': return 1;
    default: return 0;
  }
}

function isWorsening(trend: TrendState | null): boolean { return trend === 'rising' || trend === 'surging'; }
function isEasing(trend: TrendState | null): boolean { return trend === 'easing'; }
function trendOf(line: RelationLine): TrendState | null { return line.trend?.state ?? null; }
function countryName(iso2: string, locale: 'ko' | 'en'): string {
  try {
    const names = new Intl.DisplayNames([locale], { type: 'region' });
    const name = names.of(iso2.toUpperCase());
    const unknown = names.of('ZZ');
    return !name || name === unknown ? iso2 : name;
  } catch { return iso2; }
}


/** Area-weighted centroid of a ring (shoelace); null for degenerate rings. */
function ringCentroid(ring: [number, number][]): { area: number; lon: number; lat: number } | null {
  let a = 0; let cx = 0; let cy = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [x0, y0] = ring[j]!; const [x1, y1] = ring[i]!;
    const f = x0 * y1 - x1 * y0;
    a += f; cx += (x0 + x1) * f; cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-9) return null;
  return { area: Math.abs(a / 2), lon: cx / (3 * a), lat: cy / (3 * a) };
}

/**
 * Map position of a line endpoint: the snapshot's anchor for non-country codes
 * (EU), else the centroid of the country's largest polygon (so the US resolves
 * to the lower 48 and Russia to its mainland, unlike a bbox midpoint).
 */
export function endpointCoord(code: string, anchors: Record<string, [number, number]>): [number, number] | null {
  const anchored = anchors[code];
  if (anchored) return anchored;
  let best: { area: number; lon: number; lat: number } | null = null;
  for (const polygon of getCountryPolygons(code) ?? []) {
    const outer = polygon[0];
    const c = outer ? ringCentroid(outer) : null;
    if (c && (!best || c.area > best.area)) best = c;
  }
  if (best) return [best.lon, best.lat];
  const fallback = getCountryCentroid(code);
  return fallback ? [fallback.lon, fallback.lat] : null;
}
export function buildWorldMapView(snapshot: WorldOverviewSnapshot, fields: readonly WorldField[], selectedIso2: string | null): WorldMapView {
  const enabled = new Set(fields);
  const military = enabled.has('military');
  const diplomacy = enabled.has('diplomacy');
  const politics = enabled.has('politics');
  const countries: WorldMapView['countries'] = {};
  for (const [iso2, state] of Object.entries(snapshot.countries)) {
    countries[iso2] = {
      iso2, level: military ? fillLevelFor(countryFill(state)) : null,
      unrestOutline: politics && state.unrest,
      blocIds: diplomacy ? [...state.blocs] : [],
    };
  }
  // Include anchored countries omitted by the feed as calm, so the renderer can
  // distinguish known geography from a missing snapshot.
  for (const iso2 of Object.keys(snapshot.anchors)) {
    countries[iso2] ??= { iso2, level: military ? 0 : null, unrestOutline: false, blocIds: [] };
  }
  const relatedIso2 = selectedIso2 ? [...new Set(snapshot.relations
    .filter((line) => line.from === selectedIso2 || line.to === selectedIso2)
    .flatMap((line) => [line.from, line.to]).filter((iso2) => iso2 !== selectedIso2))] : [];
  const visible = selectVisibleLines(snapshot, fields).filter((line) => isDrawableEndpoint(line.from, snapshot.anchors) && isDrawableEndpoint(line.to, snapshot.anchors));
  const tagCandidates = visible.filter((line) => isWorsening(trendOf(line)) || isEasing(trendOf(line)));
  let tagged: Set<string>;
  if (selectedIso2) tagged = new Set(tagCandidates.filter((line) => line.from === selectedIso2 || line.to === selectedIso2).map((line) => line.id));
  else {
    tagged = new Set();
    const used = new Set<string>();
    for (const line of [...tagCandidates].sort((a, b) => b.score - a.score)) {
      if (used.has(line.from) || used.has(line.to)) continue;
      tagged.add(line.id); used.add(line.from); used.add(line.to);
      if (tagged.size === 6) break;
    }
  }
  const lines: WorldLineView[] = [];
  for (const line of visible) {
    const fromCoord = endpointCoord(line.from, snapshot.anchors);
    const toCoord = endpointCoord(line.to, snapshot.anchors);
    // No geometry for an endpoint (tiny territory, geometry not loaded yet): skip the line.
    if (!fromCoord || !toCoord) continue;
    lines.push({
      id: line.id, origin: line.origin, kind: line.kind, field: line.field, from: line.from, to: line.to,
      fromCoord, toCoord, directed: line.directed,
      trend: trendOf(line), worsening: isWorsening(trendOf(line)), easing: isEasing(trendOf(line)), showTag: tagged.has(line.id),
      label: line.label, reappeared: line.mark?.state === 'reappeared',
    });
  }
  const blocOutlines = diplomacy ? snapshot.blocs.map((bloc, colorIndex) => ({ blocId: bloc.id, members: bloc.members, colorIndex })) : [];
  return { date: snapshot.date, countries, lines, blocOutlines, selectedIso2, relatedIso2 };
}

function relationForCountry(line: RelationLine, iso2: string): DrawerRelation {
  const counterpartIso2 = line.from === iso2 ? line.to : line.from;
  return {
    id: line.id, counterpartIso2, counterpartName: countryName(counterpartIso2, 'ko'), kind: line.kind, field: line.field,
    origin: line.origin, direction: !line.directed ? 'both' : line.from === iso2 ? 'out' : 'in', label: line.label,
    trend: trendOf(line), sources: line.sources, ...(line.mark ? { mark: line.mark } : {}),
  };
}

export function buildCountryDrawerData(snapshot: WorldOverviewSnapshot, iso2: string, todayDate: string): CountryDrawerData {
  const country = snapshot.countries[iso2];
  const issue = country?.issue;
  return {
    iso2, nameKo: countryName(iso2, 'ko'), nameEn: countryName(iso2, 'en'),
    level: country?.level ? fillLevelFor(country.level) as CountryDrawerData['level'] : null,
    conflictLevel: country?.level ?? null, ciiScore: country?.cii?.score ?? null, updatedAt: snapshot.generatedAt,
    issue: issue ? { summaryKo: issue.summaryKo, sources: issue.sources, ...(issue.mark ? { mark: issue.mark } : {}) } : null,
    // Hidden (wrong-marked) relations stay listed so the drawer can offer the undo.
    relations: snapshot.relations.filter((line) => line.from === iso2 || line.to === iso2).map((line) => relationForCountry(line, iso2)),
    blocs: (country?.blocs ?? []).map((id) => ({ id, nameKo: snapshot.blocs.find((bloc) => bloc.id === id)?.nameKo ?? id })),
    isToday: snapshot.date === todayDate, aiStatus: snapshot.ai.status,
  };
}

export function filterDrawerRelations(rels: DrawerRelation[], filter: 'all' | 'worsening' | 'easing'): DrawerRelation[] {
  if (filter === 'all') return rels;
  return rels.filter((relation) => filter === 'worsening' ? isWorsening(relation.trend) : isEasing(relation.trend));
}
