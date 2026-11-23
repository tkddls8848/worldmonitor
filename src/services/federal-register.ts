import { ensureHydrated } from '@/services/bootstrap';
import type { FederalRegisterDocument, FederalRegisterTopic } from '@/types/world-overview';

const TOPIC_LABELS: Record<FederalRegisterTopic, string> = {
  tariff: '관세',
  sanctions: '제재',
  'export-control': '수출 통제',
  'monetary/financial': '통화·금융',
  defense: '국방',
  other: '기타',
};

export function federalRegisterLabel(document: FederalRegisterDocument): string {
  return document.type === 'Executive Order' ? '행정명령' : TOPIC_LABELS[document.topic];
}

function isDocument(value: unknown): value is FederalRegisterDocument {
  if (!value || typeof value !== 'object') return false;
  const doc = value as Partial<FederalRegisterDocument>;
  return typeof doc.id === 'string' && typeof doc.title === 'string'
    && typeof doc.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(doc.date) && Number.isFinite(Date.parse(doc.date))
    && typeof doc.type === 'string' && typeof doc.topic === 'string' && Object.prototype.hasOwnProperty.call(TOPIC_LABELS, doc.topic)
    && Array.isArray(doc.countries) && doc.countries.every((code) => typeof code === 'string' && /^[A-Z]{2}$/.test(code))
    && typeof doc.url === 'string' && doc.url.startsWith('https://www.federalregister.gov/documents/');
}

export async function loadFederalRegister(): Promise<FederalRegisterDocument[]> {
  const snapshot = await ensureHydrated('federalRegister') as { items?: unknown } | undefined;
  return Array.isArray(snapshot?.items) ? snapshot.items.filter(isDocument) : [];
}
