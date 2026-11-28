export const IMPACT_LINKS_KEY = 'world:impact-links:v1';
export const IMPACT_DAY_MS = 86_400_000;
export const UCDP_WINDOW_DAYS = 30;
export const IMPACT_KINDS = ['sanctions', 'tariffs', 'conflict', 'tension', 'support', 'energy', 'financial'] as const;

type PressureLink = {
  actor: string;
  target: string;
  kind: string;
  direction: string;
  magnitude: number;
  trend: string;
  lastSeen: number;
  undirected?: boolean;
};

type CountryPressure = { incoming: Record<string, number>; outgoing: Record<string, number> };

/** Expects only links between distinct endpoints, in descending significance order. */
export function summarizeImpactLinks<T extends PressureLink>(links: readonly T[], asOf: number) {
  const today: T[] = [];
  const byCountry: Record<string, CountryPressure> = {};
  const totals = (country: string) => byCountry[country] ??= { incoming: {}, outgoing: {} };
  const add = (side: Record<string, number>, kind: string, magnitude: number) => {
    side[kind] = (side[kind] ?? 0) + magnitude;
  };

  for (const link of links) {
    if (link.lastSeen >= asOf - IMPACT_DAY_MS && ['new', 'rising'].includes(link.trend)) {
      if (today.length < 7) today.push(link);
      else if ((link.target === 'KR' || link.actor === 'KR') && !today.some((item) => item.target === 'KR' || item.actor === 'KR')) {
        today[today.length - 1] = link;
      }
    }
    if (link.direction !== 'pressure' || link.undirected) continue;
    add(totals(link.target).incoming, link.kind, link.magnitude);
    if (link.actor !== link.target && !['EU', 'UN', 'NATO'].includes(link.actor)) {
      add(totals(link.actor).outgoing, link.kind, link.magnitude);
    }
  }

  return { today, byCountry };
}
