import { countryFill, selectVisibleLines, isDrawableEndpoint } from '../../shared/world-overview.js';
import type { WorldOverviewSnapshot, CountryFill, RelationLine, TrendState } from '../../shared/world-overview.js';
import type { FillLevel, WorldField, WorldMapView, WorldLineView, CountryDrawerData, DrawerRelation } from '@/types/world-overview';

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
  const lines: WorldLineView[] = visible.map((line) => ({
    id: line.id, origin: line.origin, kind: line.kind, field: line.field, from: line.from, to: line.to,
    fromCoord: snapshot.anchors[line.from]!, toCoord: snapshot.anchors[line.to]!, directed: line.directed,
    trend: trendOf(line), worsening: isWorsening(trendOf(line)), easing: isEasing(trendOf(line)), showTag: tagged.has(line.id),
    label: line.label, reappeared: line.mark?.state === 'reappeared',
  }));
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
    relations: snapshot.relations.filter((line) => (line.from === iso2 || line.to === iso2) && line.mark?.state !== 'hidden').map((line) => relationForCountry(line, iso2)),
    blocs: (country?.blocs ?? []).map((id) => ({ id, nameKo: snapshot.blocs.find((bloc) => bloc.id === id)?.nameKo ?? id })),
    isToday: snapshot.date === todayDate, aiStatus: snapshot.ai.status,
  };
}

export function filterDrawerRelations(rels: DrawerRelation[], filter: 'all' | 'worsening' | 'easing'): DrawerRelation[] {
  if (filter === 'all') return rels;
  return rels.filter((relation) => filter === 'worsening' ? isWorsening(relation.trend) : isEasing(relation.trend));
}
