import { IntelligenceServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';

const client = new IntelligenceServiceClient(getRpcBaseUrl(), {
  fetch: (...args: Parameters<typeof fetch>) => globalThis.fetch(...args),
});

export function getDemographicsCapability({ countryCode, signal }: { countryCode: string; signal?: AbortSignal }) {
  return client.getDemographicsCapability(
    { countryCode: countryCode.trim().toUpperCase() },
    signal ? { signal } : undefined,
  );
}
