import { ensureHydrated } from '@/services/bootstrap';

export interface FundingStress {
  asOf: number;
  sofr: { rate: number; changeBp: number | null; date: string } | null;
  effr: { rate: number; changeBp: number | null; date: string } | null;
  rrp: { amountBn: number; change1dBn: number | null; date: string } | null;
  ofrFsi: { value: number; change1d: number | null; date: string; components: Record<string, number> } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function loadFundingStress(): Promise<FundingStress | null> {
  const raw: unknown = await ensureHydrated('fundingStress');
  if (!isRecord(raw) || typeof raw.asOf !== 'number') return null;
  for (const key of ['sofr', 'effr', 'rrp', 'ofrFsi'] as const) {
    if (raw[key] !== null && !isRecord(raw[key])) return null;
  }
  return raw as unknown as FundingStress;
}
