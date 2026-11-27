import {
  ValidationError,
  type GetImpactLinksRequest,
  type GetImpactLinksResponse,
  type ServerContext,
} from '../../../../src/generated/server/worldmonitor/world_overview/v1/service_server';
import { IMPACT_DAY_MS, IMPACT_KINDS, IMPACT_LINKS_KEY, summarizeImpactLinks } from '../../../../shared/impact-links';
import { isAssignedCountryCode } from '../../../../shared/country-code-resolve';
import { getCachedJson } from '../../../_shared/redis';

type ReadSnapshot = (key: string) => Promise<unknown>;

export async function getImpactLinks(
  _ctx: ServerContext,
  req: GetImpactLinksRequest,
  readSnapshot: ReadSnapshot = (key) => getCachedJson(key, true),
): Promise<GetImpactLinksResponse> {
  const kind = req.kind.trim().toLowerCase();
  const country = req.country.trim().toUpperCase();
  const window = req.window.trim() || '7d';
  if (kind && !IMPACT_KINDS.some((value) => value === kind)) {
    throw new ValidationError([{ field: 'kind', description: 'Use a supported impact kind.' }]);
  }
  if (country && !isAssignedCountryCode(country)) {
    throw new ValidationError([{ field: 'country', description: 'Use an assigned ISO alpha-2 country code.' }]);
  }
  if (window !== '24h' && window !== '7d') {
    throw new ValidationError([{ field: 'window', description: 'Use 24h or 7d.' }]);
  }
  if (!Number.isInteger(req.limit) || req.limit < 0 || req.limit > 500) {
    throw new ValidationError([{ field: 'limit', description: 'Use an integer from 1 to 500, or omit for the default.' }]);
  }

  const data = await readSnapshot(IMPACT_LINKS_KEY) as GetImpactLinksResponse | null;
  if (!data || !Number.isSafeInteger(data.generatedAt) || !Array.isArray(data.links)) {
    return { generatedAt: 0, links: [], summary: { today: [], byCountry: {} } };
  }
  const since = data.generatedAt - (window === '24h' ? 1 : 7) * IMPACT_DAY_MS;
  const links = data.links.filter((link) => link.lastSeen >= since
    && (!kind || link.kind === kind)
    && (!country || link.actor === country || link.target === country));
  return {
    generatedAt: data.generatedAt,
    links: links.slice(0, req.limit || 100),
    summary: summarizeImpactLinks(links, data.generatedAt),
  };
}
