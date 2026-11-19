import type { ShippingV2ServiceHandler } from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

import { routeIntelligence } from './route-intelligence';
import { registerWebhook, listWebhooks } from './retired-webhooks';

export const shippingV2Handler: ShippingV2ServiceHandler = {
  routeIntelligence,
  registerWebhook,
  listWebhooks,
};
