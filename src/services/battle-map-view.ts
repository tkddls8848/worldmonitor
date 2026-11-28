import { COUNTRY_EVENT_LABELS, isImpactKind, IMPACT_STYLES, type ImpactKind } from '@/config/battle-map';
import type { CountryImpactEvent, ImpactLink } from '@/services/impact-links';
import { countryName, endpointCoord } from '@/services/world-overview-view';
import type { FillLevel } from '@/types/world-overview';
import { IMPACT_DAY_MS as DAY } from '../../shared/impact-links';

export type ImpactWindow = '24h' | '7d';
type Coordinate = [number, number];
export interface BattleArc {
  link: ImpactLink;
  kind: ImpactKind;
  from: Coordinate;
  to: Coordinate;
  opacity: number;
  level: number;
  bundle: ImpactLink[];
  emphasized: boolean;
  animated: boolean;
}
export interface BattleCrest { code: string; at: Coordinate; count: number; label: boolean; dimmed: boolean }
export interface BattleEventMarker { event: CountryImpactEvent; at: Coordinate; offset: number }

export function impactDate(at: number): string {
  return new Date(at).toISOString().slice(5, 10);
}

export function impactCountry(code: string): string {
  return { EU: '유럽연합', UN: '유엔', NATO: '북대서양조약기구' }[code] ?? countryName(code, 'ko');
}

export function impactHeadline(link: ImpactLink): string {
  if (!isImpactKind(link.kind)) return '';
  if (link.evidence.some((evidence) => evidence.aiExtracted && evidence.aiSummary === link.headline)) return link.headline;
  const label = IMPACT_STYLES[link.kind].detail;
  return `${impactCountry(link.actor)} ${link.undirected ? '—' : '→'} ${impactCountry(link.target)} · ${label}`;
}

export function countryEventLabel(event: CountryImpactEvent): string {
  return isImpactKind(event.kind) ? COUNTRY_EVENT_LABELS[event.kind] ?? IMPACT_STYLES[event.kind].detail : '국내 사건';
}

export function countryEventValue(event: CountryImpactEvent): string {
  return event.kind === 'conflict' ? `${event.eventCount}건` : `강도 ${event.magnitude}/100`;
}

export function impactFreshness(lastSeen: number, asOf: number): number {
  const age = asOf - lastSeen;
  return age <= DAY / 4 ? 1 : age <= DAY ? 0.88 : age <= 3 * DAY ? 0.60 : 0.32;
}

export function impactTrend(link: ImpactLink, asOf: number): string {
  if (link.lastSeen < asOf - DAY) return '';
  return link.trend === 'new' ? '신규' : link.trend === 'rising' ? '급등' : '';
}

export function pressureLevel(score: number): FillLevel {
  return score >= 80 ? 4 : score >= 60 ? 3 : score >= 35 ? 2 : score >= 15 ? 1 : 0;
}

export function filterImpactWindow<T extends { kind: string; lastSeen: number }>(items: readonly T[], window: ImpactWindow, asOf: number): T[] {
  const since = asOf - (window === '24h' ? 1 : 7) * DAY;
  return items.filter((item) => isImpactKind(item.kind) && (item.lastSeen >= since || (window === '7d' && item.kind === 'conflict')));
}

export function buildCountryEventMarkers(events: readonly CountryImpactEvent[], anchors: Record<string, Coordinate>): BattleEventMarker[] {
  const offsets = new Map<string, number>();
  return events.flatMap((event) => {
    const at = endpointCoord(event.country, anchors);
    if (!at) return [];
    const index = offsets.get(event.country) ?? 0;
    offsets.set(event.country, index + 1);
    return [{ event, at, offset: index * 13 }];
  });
}

export function buildBattleView(
  links: readonly ImpactLink[],
  anchors: Record<string, Coordinate>,
  asOf: number,
  selectedCountry: string | null,
  selectedLink: ImpactLink | null,
) {
  const score = (link: ImpactLink) => link.magnitude * impactFreshness(link.lastSeen, asOf);
  const pressure: Record<string, number> = {};
  const outgoing = new Map<string, { score: number; count: number }>();
  const byPair = new Map<string, ImpactLink[]>();
  const related = new Set<string>();
  const coords = new Map<string, Coordinate | null>();
  const locate = (code: string) => {
    if (!coords.has(code)) coords.set(code, endpointCoord(code, anchors));
    return coords.get(code);
  };

  for (const link of links) {
    if (link.direction === 'pressure' && !link.undirected) {
      pressure[link.target] = (pressure[link.target] ?? 0) + score(link);
      if (link.actor !== link.target && !['EU', 'UN', 'NATO'].includes(link.actor)) {
        const total = outgoing.get(link.actor) ?? { score: 0, count: 0 };
        total.score += score(link);
        total.count++;
        outgoing.set(link.actor, total);
      }
    }
    if (selectedCountry === link.actor) related.add(link.target);
    if (selectedCountry === link.target) related.add(link.actor);
    const key = `${link.actor}:${link.target}`;
    const group = byPair.get(key) ?? [];
    group.push(link);
    byPair.set(key, group);
  }
  for (const code of Object.keys(pressure)) pressure[code] = Math.min(100, Math.round(pressure[code]!));
  if (selectedLink) {
    related.add(selectedLink.actor);
    related.add(selectedLink.target);
  }

  const emphasized = (link: ImpactLink) => selectedLink
    ? link.actor === selectedLink.actor && link.target === selectedLink.target
    : link.actor === selectedCountry || link.target === selectedCountry;
  const ranked = [...links].sort((a, b) => Number(emphasized(b)) - Number(emphasized(a)) || score(b) - score(a) || b.lastSeen - a.lastSeen);
  // Give each available kind a representative before filling the wide view by score.
  const byKind = new Map<string, ImpactLink>();
  for (const link of ranked) if (!byKind.has(link.kind)) byKind.set(link.kind, link);
  const candidates = selectedCountry || selectedLink ? ranked : [...byKind.values(), ...ranked];
  if (selectedLink) candidates.unshift(selectedLink);
  const arcs: BattleArc[] = [];
  const drawn = new Set<string>();
  let motion = 0;
  for (const link of candidates) {
    if (arcs.length >= (selectedCountry ? 24 : 14)) break;
    const from = locate(link.actor);
    const to = locate(link.target);
    const pair = `${link.actor}:${link.target}`;
    const key = selectedCountry ? link.id : pair;
    if (!isImpactKind(link.kind) || !from || !to || drawn.has(key)) continue;
    drawn.add(key);
    const age = asOf - link.lastSeen;
    const animated = !link.undirected && motion < 8 && age <= DAY && link.magnitude >= (age <= DAY / 4 ? 50 : 70);
    if (animated) motion++;
    arcs.push({ link, kind: link.kind, from, to, opacity: emphasized(link) ? 1
      : selectedCountry || selectedLink ? 0.17 : impactFreshness(link.lastSeen, asOf),
    level: link.magnitude >= 85 ? 3 : link.magnitude >= 65 ? 2 : link.magnitude >= 35 ? 1 : 0,
    bundle: byPair.get(pair) ?? [link], emphasized: emphasized(link), animated });
  }
  const crests = [...outgoing].sort(([, a], [, b]) => b.score - a.score).flatMap(([code, total], index): BattleCrest[] => {
    const at = locate(code);
    return at && (total.count >= 2 || total.score >= 40)
      ? [{ code, at, count: total.count, label: index < 6, dimmed: Boolean((selectedCountry || selectedLink) && code !== selectedCountry && !related.has(code)) }]
      : [];
  });
  const fronts = Object.entries(pressure).filter(([, value]) => value >= 60).sort(([, a], [, b]) => b - a).map(([code]) => code);
  return { arcs: arcs.reverse(), crests, pressure, related: [...related], fronts, ranked: [...new Set(ranked)] };
}
