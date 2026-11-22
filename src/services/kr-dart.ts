import { ensureHydrated } from '@/services/bootstrap';

export interface KrDartDisclosure {
  id: string;
  at: number;
  corpName: string;
  stockCode: string | null;
  market: 'KOSPI' | 'KOSDAQ';
  kind: 'major' | 'ownership' | 'exchange';
  title: string;
  filer: string;
  url: string;
}

export async function loadKrDartDisclosures(): Promise<KrDartDisclosure[]> {
  const snapshot = await ensureHydrated('krDartDisclosures') as { items?: KrDartDisclosure[] } | undefined;
  return Array.isArray(snapshot?.items) ? snapshot.items : [];
}
