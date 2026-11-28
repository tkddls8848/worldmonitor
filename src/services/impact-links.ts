import type { GetImpactLinksResponse } from '@/generated/client/worldmonitor/world_overview/v1/service_client';
import type { IMPACT_KINDS } from '../../shared/impact-links';
import { WorldOverviewServiceClient } from '@/services/generated-rpc-clients';
import { getRpcBaseUrl } from '@/services/rpc-client';

export type { GetImpactLinksResponse, ImpactLink } from '@/generated/client/worldmonitor/world_overview/v1/service_client';

export interface ImpactLinksFilters {
  kind?: typeof IMPACT_KINDS[number];
  country?: string;
  window?: '24h' | '7d';
  limit?: number;
}

const client = new WorldOverviewServiceClient(getRpcBaseUrl(), { fetch: (...args) => globalThis.fetch(...args) });

/** Load recent impact links on demand. The response includes pressure totals before pagination. */
export function loadImpactLinks(filters: ImpactLinksFilters = {}): Promise<GetImpactLinksResponse> {
  return client.getImpactLinks({
    kind: filters.kind ?? '',
    country: filters.country?.trim().toUpperCase() ?? '',
    window: filters.window ?? '',
    limit: filters.limit ?? 0,
  });
}
