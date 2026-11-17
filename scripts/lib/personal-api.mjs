// Where a seeder sends its WorldMonitor API calls. This fork has no hosted
// API: unless API_BASE_URL names another server, the target is the personal
// server's Basic-auth ingress (npm run start:personal), the same origin
// seed-news-digest and the TUI use. tests/personal-seeders-no-upstream-hosts
// fails if a seeder defaults to the upstream operator's hosts again.
import { createPersonalFetch, personalOrigin } from '../personal-tui.mjs';

export function wmApiBase(env = process.env) {
  const configured = typeof env.API_BASE_URL === 'string' ? env.API_BASE_URL.trim() : '';
  return (configured || personalOrigin(env)).replace(/\/+$/, '');
}

// A fetch that adds the owner's credential to requests for the personal server
// only. Without WM_PERSONAL_PASSWORD it adds nothing, and the server's 401
// names the problem.
//
// The warm-ping seeders still send `Origin: https://worldmonitor.app`, which
// the upstream API trusted. The personal ingress refuses any /api/ request
// whose Origin is not its own host (403), and the owner credential is what
// authenticates there, so that header is dropped for the personal server only.
export function wmApiFetch(env = process.env, fetchImpl = (...args) => globalThis.fetch(...args)) {
  if (!env.WM_PERSONAL_PASSWORD) return fetchImpl;
  const origin = personalOrigin(env);
  const withoutOrigin = (input, init = {}) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.origin !== origin || !init.headers) return fetchImpl(input, init);
    const headers = Object.fromEntries(Object.entries(init.headers).filter(([name]) => name.toLowerCase() !== 'origin'));
    return fetchImpl(input, { ...init, headers });
  };
  return createPersonalFetch({
    origin,
    username: env.WM_PERSONAL_USERNAME || 'owner',
    password: env.WM_PERSONAL_PASSWORD,
    fetchImpl: withoutOrigin,
  });
}
