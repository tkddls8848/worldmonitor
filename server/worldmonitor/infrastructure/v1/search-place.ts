import type {
  InfrastructureServiceHandler,
  ServerContext,
  SearchPlaceRequest,
  SearchPlaceResponse,
  PlaceMatch,
} from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { ApiError, ValidationError } from '../../../../src/generated/server/worldmonitor/infrastructure/v1/service_server';
import { cachedFetchJsonWithMeta } from '../../../_shared/redis';
import { sha256Hex } from '../../../_shared/hash';
import { isOrbitalWatchEnabled } from '../../orbital/v1/dark-launch';

const NOMINATIM_SEARCH = 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'WorldMonitor/2.0 (https://worldmonitor.app)';
const MAX_RESULTS = 5;
const MIN_QUERY_CHARS = 2;
const MAX_QUERY_CHARS = 200;
const FOUND_TTL_SECONDS = 604_800;
const NOT_FOUND_TTL_SECONDS = 86_400;
interface NominatimPlace {
  lat?: string;
  lon?: string;
  display_name?: string;
  type?: string;
  addresstype?: string;
}

/** Case and spacing variants of one name share a cache entry. */
export function normalizePlaceQuery(raw: string): string {
  return raw.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

/** The name is caller text, so the key carries a fixed-width digest of it. */
export const placeSearchCacheKey = async (query: string) => `geocode:search:v2:${await sha256Hex(query)}`;

function toMatch(place: NominatimPlace): PlaceMatch | null {
  const lat = Number(place.lat);
  const lon = Number(place.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const name = (place.display_name ?? '').trim();
  if (!name) return null;
  return { name, lat, lon, kind: place.addresstype || place.type || '' };
}

async function fetchPlaces(query: string): Promise<PlaceMatch[] | null> {
  const params = new URLSearchParams({ q: query, format: 'jsonv2', limit: String(MAX_RESULTS), 'accept-language': 'en' });
  const resp = await fetch(`${NOMINATIM_SEARCH}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!resp.ok) throw new Error(`Nominatim search HTTP ${resp.status}`);
  const body: unknown = await resp.json();
  const places = (Array.isArray(body) ? body : [])
    .map((place) => toMatch(place as NominatimPlace))
    .filter((match): match is PlaceMatch => match !== null)
    .slice(0, MAX_RESULTS);
  return places.length > 0 ? places : null;
}

/** SearchPlace resolves a submitted place name through OpenStreetMap Nominatim, cached per normalised name. */
export const searchPlace: InfrastructureServiceHandler['searchPlace'] = async (
  _ctx: ServerContext,
  req: SearchPlaceRequest,
): Promise<SearchPlaceResponse> => {
  // Place search exists for the Orbital Watch lookup, so it ships dark with it (#10710).
  if (!isOrbitalWatchEnabled()) throw new ApiError(404, 'Not found', '');
  const query = normalizePlaceQuery(req.q ?? '');
  if (query.length < MIN_QUERY_CHARS || query.length > MAX_QUERY_CHARS) {
    throw new ValidationError([{ field: 'q', description: `must be ${MIN_QUERY_CHARS} to ${MAX_QUERY_CHARS} characters` }]);
  }
  try {
    const { data: places } = await cachedFetchJsonWithMeta<PlaceMatch[]>(await placeSearchCacheKey(query), FOUND_TTL_SECONDS,
      () => fetchPlaces(query),
      NOT_FOUND_TTL_SECONDS, { cacheFetcherErrors: false });
    return { places: places ?? [], error: '' };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    return { places: [], error: 'Place search failed' };
  }
};
