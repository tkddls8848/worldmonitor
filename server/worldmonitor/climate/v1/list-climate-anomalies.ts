/**
 * ListClimateAnomalies RPC reads the output of the Open-Meteo climate collector.
 */

import type {
  ClimateServiceHandler,
  ServerContext,
  ListClimateAnomaliesRequest,
  ListClimateAnomaliesResponse,
} from '../../../../src/generated/server/worldmonitor/climate/v1/service_server';

import { logCacheReadError, readCachedJson } from '../../../_shared/redis';
import { SeedUnavailableError } from '../../../_shared/required-seed';
import { CLIMATE_ANOMALIES_KEY } from '../../../_shared/cache-keys';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';

export const listClimateAnomalies: ClimateServiceHandler['listClimateAnomalies'] = async (
  ctx: ServerContext,
  _req: ListClimateAnomaliesRequest,
): Promise<ListClimateAnomaliesResponse> => {
  const cached = await readCachedJson(CLIMATE_ANOMALIES_KEY, true);
  if (cached.status === 'miss') {
    return markNoStoreFallbackResponse(ctx.request, { anomalies: [], pagination: undefined });
  }
  if (cached.status === 'error') {
    logCacheReadError(CLIMATE_ANOMALIES_KEY, cached.error);
    throw new SeedUnavailableError(CLIMATE_ANOMALIES_KEY);
  }
  const data = cached.value as ListClimateAnomaliesResponse | null;
  if (!Array.isArray(data?.anomalies)) throw new SeedUnavailableError(CLIMATE_ANOMALIES_KEY);
  return { anomalies: data.anomalies, pagination: data.pagination };
};
