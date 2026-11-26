import { createRelayHandler } from './_personal-providers.js';

export const config = { runtime: 'edge' };

const relayHandler = createRelayHandler({
  relayPath: '/opensky',
  timeout: 20000,
  cacheHeaders: () => ({
    'Cache-Control': 'private, no-store',
    'CDN-Cache-Control': 'no-store',
  }),
  extraHeaders: (response) => {
    const xCache = response.headers.get('x-cache');
    return xCache ? { 'X-Cache': xCache } : {};
  },
});

function noStore(response) {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('CDN-Cache-Control', 'no-store');
  return response;
}

export default async function handler(req) {
  return noStore(await relayHandler(req));
}
