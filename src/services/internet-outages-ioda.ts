import { ensureHydrated } from '@/services/bootstrap';

export interface IodaOutage {
  id: string;
  iso2: string;
  countryName: string;
  start: number;
  end: number | null;
  severity: 'low' | 'medium' | 'high';
  signals: string[];
  score: number | null;
  url: string;
}

/** Load the separately seeded IODA events; the Cloudflare outage key is independent. */
export async function loadIodaOutages(): Promise<IodaOutage[]> {
  const value = await ensureHydrated('iodaOutages') as { outages?: unknown } | undefined;
  return Array.isArray(value?.outages) ? value.outages as IodaOutage[] : [];
}
