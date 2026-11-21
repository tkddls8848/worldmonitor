export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createWorldOverviewServiceRoutes } from '../../../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { worldOverviewHandler } from '../../../server/worldmonitor/world-overview/v1/handler';

export default createDomainGateway(
  createWorldOverviewServiceRoutes(worldOverviewHandler, serverOptions),
);
