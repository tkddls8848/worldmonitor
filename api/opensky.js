import { createRelayHandler } from './_relay.js';

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

const LOCAL_SIDECAR_ORIGIN = /^http:\/\/127\.0\.0\.1:\d{1,5}$/;

function isSidecarHop(origin) {
  return (process.env.LOCAL_API_MODE || '').includes('sidecar')
    && LOCAL_SIDECAR_ORIGIN.test(origin);
}

function noStore(response) {
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set('CDN-Cache-Control', 'no-store');
  return response;
}

export default async function handler(req) {
  // Access control is the personal server's HTTP Basic auth.
  const origin = req.headers.get('Origin') || '';

  // `_cors.js` intentionally rejects production loopback Origins. The local
  // sidecar replaced the renderer Origin, so normalize only this hop before
  // relay CORS.
  let relayRequest = req;
  if (isSidecarHop(origin)) {
    const headers = new Headers(req.headers);
    headers.set('Origin', 'tauri://localhost');
    relayRequest = new Request(req, { headers });
  }
  return noStore(await relayHandler(relayRequest));
}
