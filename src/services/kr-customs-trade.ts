import { ensureHydrated } from './bootstrap';

export interface KrCustomsTrade {
  asOf: number;
  month: string;
  total: { exportUsd: number; importUsd: number; balanceUsd: number; exportYoyPct: number | null; importYoyPct: number | null };
  partners: Array<{ iso2: string; nameKo: string; exportUsd: number; importUsd: number; exportYoyPct: number | null }>;
  items: Array<{ hs: string; nameKo: string; exportUsd: number; exportYoyPct: number | null }>;
  provisional: { period: string; exportUsd: number; importUsd: number; exportYoyPct: number | null } | null;
}

function isKrCustomsTrade(value: unknown): value is KrCustomsTrade {
  if (!value || typeof value !== 'object') return false;
  const data = value as Partial<KrCustomsTrade>;
  return typeof data.asOf === 'number' && /^\d{6}$/.test(data.month ?? '')
    && typeof data.total?.exportUsd === 'number' && typeof data.total.importUsd === 'number'
    && Array.isArray(data.partners) && Array.isArray(data.items);
}

export async function loadKrCustomsTrade(): Promise<KrCustomsTrade | null> {
  const value = await ensureHydrated('krCustomsTrade');
  return isKrCustomsTrade(value) ? value : null;
}
