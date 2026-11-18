/**
 * The personal ingress (scripts/personal-server.mjs) answers every request
 * without the owner's HTTP Basic credentials with 401. Reads written for the
 * public CDN tier pass credentials:'omit' (bootstrap, gpsjam, OREF, public RPC),
 * which tells the browser to drop the cached Basic credentials too, so in a
 * personal build they must go out as same-origin requests instead. Hosted
 * builds keep 'omit' exactly as before.
 */
import { afterEach, expect, it, vi } from 'vitest';

const originalFetch = window.fetch;

afterEach(() => {
  window.fetch = originalFetch;
  delete (window as unknown as Record<string, unknown>).__wmWebRedirectPatched;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.resetModules();
});

async function captureCredentials(personal: boolean): Promise<Array<RequestCredentials | undefined>> {
  vi.resetModules();
  vi.stubEnv('VITE_PERSONAL_MODE', personal ? 'true' : '');
  vi.stubEnv('VITE_WS_API_URL', '');
  vi.stubGlobal('location', {
    hostname: '127.0.0.1', host: '127.0.0.1:3000',
    protocol: 'http:', origin: 'http://127.0.0.1:3000',
    href: 'http://127.0.0.1:3000/dashboard',
  });
  const seen: Array<RequestCredentials | undefined> = [];
  window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(input instanceof Request ? input.credentials : init?.credentials);
    return new Response('{}');
  }) as typeof fetch;
  const { installWebApiRedirect } = await import('@/services/runtime');
  installWebApiRedirect();
  await window.fetch('/api/bootstrap?tier=fast', { credentials: 'omit' });
  await window.fetch(new URL('/api/gpsjam', 'http://127.0.0.1:3000'), { credentials: 'omit' });
  await window.fetch('/api/oref-alerts');
  return seen;
}

it('sends credentials:omit /api reads as same-origin in a personal build', async () => {
  expect(await captureCredentials(true)).toEqual(['same-origin', 'same-origin', 'include']);
});

it('keeps credentials:omit unchanged in a hosted build', async () => {
  expect(await captureCredentials(false)).toEqual(['omit', 'omit', 'include']);
});
