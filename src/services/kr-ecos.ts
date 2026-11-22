import { ensureHydrated } from '@/services/bootstrap';

export interface KrEcosIndicator {
  id: string;
  nameKo: string;
  value: number;
  unit: string;
  period: string;
  change: number | null;
  changeKind: 'abs' | 'pct' | 'bp' | null;
}

export interface KrEcosMacro {
  asOf: number;
  indicators: KrEcosIndicator[];
}

export async function loadKrEcosMacro(): Promise<KrEcosMacro | null> {
  const value: unknown = await ensureHydrated('krEcosMacro');
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Partial<KrEcosMacro>;
  if (typeof raw.asOf !== 'number' || !Number.isFinite(raw.asOf) || !Array.isArray(raw.indicators)) return null;
  const indicators = raw.indicators.filter((item): item is KrEcosIndicator => !!item && typeof item.id === 'string'
    && typeof item.nameKo === 'string' && typeof item.value === 'number' && Number.isFinite(item.value)
    && typeof item.unit === 'string' && typeof item.period === 'string'
    && (item.change === null || (typeof item.change === 'number' && Number.isFinite(item.change)))
    && (item.changeKind === null || item.changeKind === 'abs' || item.changeKind === 'pct' || item.changeKind === 'bp'));
  return { asOf: raw.asOf, indicators };
}
