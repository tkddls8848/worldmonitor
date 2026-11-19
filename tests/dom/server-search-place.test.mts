// @vitest-environment node

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { cache, inflight, backoff, limiter } = vi.hoisted(() => ({
  cache: new Map<string, unknown>(),
  backoff: new Set<string>(),
  inflight: new Map<string, Promise<unknown>>(),
  limiter: vi.fn(async (_scope: string, _limit: number, _window: string, _identifier: string) => ({ allowed: true, degraded: false })),
}));
vi.mock('../../server/_shared/redis', () => ({
  // Mirrors redis.ts: a fetcher error arms a per-key backoff unless the caller marks it caller-local.
  cachedFetchJsonWithMeta: vi.fn(async (key: string, ttl: number, fetcher: () => Promise<unknown>, negativeTtl: number,
    opts?: { isCallerLocalError?: (error: unknown) => boolean }) => {
    if (cache.has(key)) return { data: (cache.get(key) as { value: unknown }).value, source: 'cache', leader: false };
    if (backoff.has(key)) throw new Error(`unavailable backoff active for "${key}"`);
    const pending = inflight.get(key) ?? fetcher()
      .then((value) => { cache.set(key, { value, ttl: value === null ? negativeTtl : ttl }); return value; })
      .catch((error: unknown) => { if (!opts?.isCallerLocalError?.(error)) backoff.add(key); throw error; })
      .finally(() => inflight.delete(key));
    inflight.set(key, pending);
    return { data: await pending, source: 'fresh', leader: true };
  }),
}));

import { normalizePlaceQuery, placeSearchCacheKey, searchPlace } from '../../server/worldmonitor/infrastructure/v1/search-place';

const ctx = { request: new Request('https://worldmonitor.test') } as Parameters<typeof searchPlace>[0];
const rotterdam = [
  { lat: '51.9244', lon: '4.4777', display_name: 'Rotterdam, South Holland, Netherlands', addresstype: 'city', type: 'administrative' },
  { lat: 'not-a-number', lon: '4', display_name: 'Broken row' },
  { lat: '91', lon: '4', display_name: 'Off the globe' },
];

beforeEach(() => {
  cache.clear();
  inflight.clear();
  backoff.clear();
  limiter.mockResolvedValue({ allowed: true, degraded: false });
  vi.stubGlobal('fetch', vi.fn(async () => Response.json(rotterdam)));
  vi.stubEnv('ORBITAL_WATCH_ENABLED', 'true');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe('place-name search', () => {
  it('answers 404 without calling Nominatim while Orbital Watch is dark', async () => {
    vi.stubEnv('ORBITAL_WATCH_ENABLED', '');
    await expect(searchPlace(ctx, { q: 'Rotterdam' })).rejects.toMatchObject({ statusCode: 404 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('asks Nominatim search once for a name and returns valid places only', async () => {
    const result = await searchPlace(ctx, { q: '  Rotterdam ' });
    expect(result).toEqual({ places: [{ name: 'Rotterdam, South Holland, Netherlands', lat: 51.9244, lon: 4.4777, kind: 'city' }], error: '' });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    const requested = new URL(String(url));
    expect(requested.origin + requested.pathname).toBe('https://nominatim.openstreetmap.org/search');
    expect(requested.searchParams.get('q')).toBe('rotterdam');
    expect(requested.searchParams.get('limit')).toBe('5');
    expect((init as RequestInit).headers).toMatchObject({ 'User-Agent': expect.stringContaining('WorldMonitor') });
  });

  it('serves a repeat of the same name, in any case or spacing, from cache', async () => {
    await searchPlace(ctx, { q: 'Rotterdam' });
    const again = await searchPlace(ctx, { q: 'ROTTERDAM   ' });
    expect(again.places).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(cache.has(await placeSearchCacheKey(normalizePlaceQuery('rotterdam')))).toBe(true);
  });

  it('shares one Nominatim call between concurrent searches for the same name', async () => {
    const [first, second] = await Promise.all([searchPlace(ctx, { q: 'Rotterdam' }), searchPlace(ctx, { q: 'rotterdam' })]);
    expect(first.places).toHaveLength(1);
    expect(second).toEqual(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    // One caller check and one provider token for the single miss.
  });

  it('keeps a name with no match for a day and a found name for a week', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json([]));
    expect(await searchPlace(ctx, { q: 'Nowhereville' })).toEqual({ places: [], error: '' });
    await searchPlace(ctx, { q: 'Rotterdam' });
    expect(cache.get(await placeSearchCacheKey('nowhereville'))).toMatchObject({ ttl: 86_400 });
    expect(cache.get(await placeSearchCacheKey('rotterdam'))).toMatchObject({ ttl: 604_800 });
  });


  it('keys the cache by a fixed-width digest, never the caller text', async () => {
    const key = await placeSearchCacheKey(normalizePlaceQuery('x'.repeat(200)));
    expect(key).toMatch(/^geocode:search:v2:[0-9a-f]{64}$/);
    await searchPlace(ctx, { q: 'Rotterdam' });
    expect([...cache.keys()].some((k) => k.includes('rotterdam'))).toBe(false);
  });






  it('rejects a one-character name before any lookup', async () => {
    await expect(searchPlace(ctx, { q: ' x ' })).rejects.toMatchObject({ name: 'ValidationError', violations: [{ field: 'q' }] });
    expect(limiter).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports an upstream failure without caching it', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('busy', { status: 503 }));
    expect(await searchPlace(ctx, { q: 'Rotterdam' })).toEqual({ places: [], error: 'Place search failed' });
    expect(cache.size).toBe(0);
  });
});
