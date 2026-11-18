import { createLazyClient, getRpcBaseUrl } from '@/services/rpc-client';
import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';
export type { WsbTicker } from '@/generated/client/worldmonitor/intelligence/v1/service_client';

const getClient = createLazyClient(() => new IntelligenceServiceClient(getRpcBaseUrl(), { fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args) }));

export async function fetchWsbTickers() {
  try {
    return (await getClient().listWsbTickers({}, { signal: AbortSignal.timeout(15_000) })).tickers;
  } catch {
    return [];
  }
}
