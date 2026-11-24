import type {
  IntelligenceServiceHandler,
  ServerContext,
  GetSocialVelocityRequest,
  GetSocialVelocityResponse,
} from '../../../../src/generated/server/worldmonitor/intelligence/v1/service_server';

import { getCachedJson } from '../../../_shared/redis';
import { markNoStoreFallbackResponse } from '../../../_shared/response-headers';
import { normalizeSocialVelocity } from '../../../../api/_social-velocity.js';

const REDIS_KEY = 'intelligence:social:reddit:v1';
export const getSocialVelocity: IntelligenceServiceHandler['getSocialVelocity'] = async (
  ctx: ServerContext,
  _req: GetSocialVelocityRequest,
): Promise<GetSocialVelocityResponse> => {
  const data = normalizeSocialVelocity(await getCachedJson(REDIS_KEY, true));
  return data.fetchedAt === 0 ? markNoStoreFallbackResponse(ctx.request, data) : data;
};
