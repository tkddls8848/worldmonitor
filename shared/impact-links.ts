export const IMPACT_LINKS_KEY = 'world:impact-links:v1';
export const IMPACT_DAY_MS = 86_400_000;
export const IMPACT_KINDS = ['sanctions', 'tariffs', 'conflict', 'tension', 'support', 'energy', 'financial'] as const;

type PressureLink = {
  actor: string;
  target: string;
  kind: string;
  direction: string;
  magnitude: number;
  trend: string;
  lastSeen: number;
};

type CountryPressure = { incoming: Record<string, number>; outgoing: Record<string, number> };

/** Expects links in descending significance order. Domestic stress is incoming only. */
export function summarizeImpactLinks<T extends PressureLink>(links: readonly T[], asOf: number) {
  const today: T[] = [];
  const byCountry: Record<string, CountryPressure> = {};
  const totals = (country: string) => byCountry[country] ??= { incoming: {}, outgoing: {} };
  const add = (side: Record<string, number>, kind: string, magnitude: number) => {
    side[kind] = (side[kind] ?? 0) + magnitude;
  };

  for (const link of links) {
    if (today.length < 7 && link.lastSeen >= asOf - IMPACT_DAY_MS && ['new', 'rising'].includes(link.trend)) {
      today.push(link);
    }
    if (link.direction !== 'pressure') continue;
    add(totals(link.target).incoming, link.kind, link.magnitude);
    if (link.actor !== link.target && !['EU', 'UN', 'NATO'].includes(link.actor)) {
      add(totals(link.actor).outgoing, link.kind, link.magnitude);
    }
  }

  return { today, byCountry };
}
