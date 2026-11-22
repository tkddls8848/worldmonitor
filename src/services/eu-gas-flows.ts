import { ensureHydrated } from '@/services/bootstrap';

export interface EuGasFlows {
  asOf: number;
  date: string;
  origins: Record<'russia' | 'norway' | 'northAfrica' | 'lng', {
    gwhPerDay: number;
    change7dPct: number | null;
    series: Array<{ date: string; gwhPerDay: number }>;
  } | null>;
}

export async function loadEuGasFlows(): Promise<EuGasFlows | null> {
  const value = await ensureHydrated('euGasFlows');
  if (!value || typeof value !== 'object') return null;
  return value as EuGasFlows;
}
