import type { WorldOverviewServiceHandler } from '../../../../src/generated/server/worldmonitor/world_overview/v1/service_server';

import { getWorldOverviewSnapshot } from './get-world-overview-snapshot';
import { getImpactLinks } from './get-impact-links';
import { setWorldOverviewMark } from './set-world-overview-mark';

export const worldOverviewHandler: WorldOverviewServiceHandler = {
  getWorldOverviewSnapshot,
  getImpactLinks,
  setWorldOverviewMark,
};
