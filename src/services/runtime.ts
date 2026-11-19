import { PERSONAL_MODE } from '@/config/personal-mode';

const ENV = (() => {
  try {
    return {
      VITE_WS_API_URL: import.meta.env.VITE_WS_API_URL,
    };
  } catch {
    return {} as Record<string, string | undefined>;
  }
})();

const WS_API_URL = ENV.VITE_WS_API_URL || '';
const DEFAULT_WEB_API_URL = 'https://api.worldmonitor.app';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

function isWorldMonitorWebHost(hostname: string): boolean {
  return hostname === 'worldmonitor.app'
    || hostname === 'www.worldmonitor.app'
    || hostname.endsWith('.worldmonitor.app');
}

// Loopback page origins the API deliberately refuses in production. Keep in
// step with the bare-localhost entries in api/_cors.js and server/cors.ts.
const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * A page on loopback may not send /api/ to a remote origin.
 *
 * `api/_cors.js` and `server/cors.ts` both drop bare localhost/127.0.0.1 from
 * the allow-list in production, so every such call returns 403 and the whole
 * dashboard renders unavailable. `VITE_WS_API_URL=https://api.worldmonitor.app`
 * in a developer's .env.local used to do exactly that to `npm run dev`, where
 * the Vite sebuf plugin serves those routes same-origin anyway.
 *
 * Deliberately narrow. A loopback base stays honoured, so pointing dev at a
 * local API on another port still works. Deployed and self-hosted pages are
 * untouched — and the self-hosted image proxies /api/ server-side
 * (docker/nginx.conf.template).
 */
function suppressesRemoteBase(configuredBaseUrl: string): boolean {
  if (typeof window === 'undefined') return false;
  if (!isLoopbackHostname(window.location?.hostname ?? '')) return false;
  return !isLoopbackHostname(hostnameOf(configuredBaseUrl));
}

export function getConfiguredWebApiBaseUrl(): string {
  if (PERSONAL_MODE) return '';
  if (WS_API_URL) {
    const configured = normalizeBaseUrl(WS_API_URL);
    return suppressesRemoteBase(configured) ? '' : configured;
  }

  if (typeof window === 'undefined') {
    return '';
  }

  const hostname = window.location?.hostname ?? '';
  if (!isWorldMonitorWebHost(hostname)) {
    return '';
  }

  return DEFAULT_WEB_API_URL;
}

export function getCanonicalApiOrigin(): string {
  if (PERSONAL_MODE) return typeof window === 'undefined' ? '' : window.location.origin;
  return getConfiguredWebApiBaseUrl() || DEFAULT_WEB_API_URL;
}

export function toApiUrl(path: string): string {
  if (!path.startsWith('/')) {
    return path;
  }

  const webApiBase = getConfiguredWebApiBaseUrl();
  if (!webApiBase) {
    return path;
  }

  return `${webApiBase}${path}`;
}

export {
  startSmartPollLoop,
  VisibilityHub,
} from './smart-poll-loop';
export type {
  SmartPollContext,
  SmartPollLoopHandle,
  SmartPollOptions,
  SmartPollReason,
} from './smart-poll-loop';

function canRetryRequest(input: RequestInfo | URL, init?: RequestInit): boolean {
  const request = input instanceof Request ? input : undefined;
  const method = (init?.method ?? request?.method ?? 'GET').toUpperCase();
  const signal = init?.signal === undefined ? request?.signal : init.signal;
  return (method === 'GET' || method === 'HEAD') && !signal?.aborted;
}

const ALLOWED_REDIRECT_HOSTS = /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*worldmonitor\.app(:\d+)?$/;

function isAllowedRedirectTarget(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_REDIRECT_HOSTS.test(parsed.origin) || isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

export function installWebApiRedirect(): void {
  if (typeof window === 'undefined') return;
  if ((window as unknown as Record<string, unknown>).__wmWebRedirectPatched) return;

  const apiBase = getConfiguredWebApiBaseUrl();
  const hasRedirect = !!apiBase && isAllowedRedirectTarget(apiBase);
  if (apiBase && !hasRedirect) {
    console.warn('[runtime] web API base blocked — not in hostname allowlist:', apiBase);
  }

  const nativeFetch = window.fetch.bind(window);
  const shouldRedirectPath = (pathWithQuery: string): boolean => pathWithQuery.startsWith('/api/');
  // The personal ingress requires the owner's HTTP Basic credentials on every
  // request. A credentials:'omit' read (written for the public CDN tier) would
  // drop them and get 401, so personal builds send it same-origin instead.
  const withCredentials = (init?: RequestInit): RequestInit => (
    {
      ...(init ?? {}),
      credentials: PERSONAL_MODE && init?.credentials === 'omit' ? 'same-origin' : init?.credentials ?? 'include',
    }
  );

  if (hasRedirect) {
    const API_BASE = apiBase;
    const shouldFallbackToOrigin = (status: number): boolean => (
      status === 404 || status === 405 || status === 501 || status === 502 || status === 503
    );
    const fetchWithRedirectFallback = async (
      redirectedInput: RequestInfo | URL,
      originalInput: RequestInfo | URL,
      originalInit?: RequestInit,
    ): Promise<Response> => {
      try {
        const redirectedResponse = await nativeFetch(redirectedInput, originalInit);
        if (!canRetryRequest(originalInput, originalInit) || !shouldFallbackToOrigin(redirectedResponse.status)) return redirectedResponse;
        return nativeFetch(originalInput, originalInit);
      } catch (error) {
        if (!canRetryRequest(originalInput, originalInit)) throw error;
        try {
          return await nativeFetch(originalInput, originalInit);
        } catch {
          throw error;
        }
      }
    };

    const dispatch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input === 'string') {
        if (shouldRedirectPath(input)) {
          // Relative /api/... path — redirect to API base.
          return fetchWithRedirectFallback(`${API_BASE}${input}`, input, withCredentials(init));
        }
        // Generated clients construct an absolute API-base URL, so they cannot
        // rely on the relative-path branch above for origin recovery. Keep the
        // same fallback here: browser extensions and network policy can block
        // api.worldmonitor.app while the page's own /api/ route remains usable.
        if (input.startsWith(`${API_BASE}/api/`)) {
          const pathAndSearch = input.slice(API_BASE.length);
          return fetchWithRedirectFallback(input, pathAndSearch, withCredentials(init));
        }
      }
      if (input instanceof URL) {
        const pathAndSearch = `${input.pathname}${input.search}`;
        if (input.origin === window.location.origin && shouldRedirectPath(pathAndSearch)) {
          return fetchWithRedirectFallback(new URL(`${API_BASE}${pathAndSearch}`), input, withCredentials(init));
        }
        // URL object already targeting the API base.
        if (input.origin === API_BASE && pathAndSearch.startsWith('/api/')) {
          return nativeFetch(input, withCredentials(init));
        }
      }
      if (input instanceof Request) {
        const u = new URL(input.url);
        const pathAndSearch = `${u.pathname}${u.search}`;
        if (u.origin === window.location.origin && shouldRedirectPath(pathAndSearch)) {
          return fetchWithRedirectFallback(
            new Request(`${API_BASE}${pathAndSearch}`, input),
            input.clone(),
            withCredentials(init),
          );
        }
        // Request object already targeting the API base.
        if (u.origin === API_BASE && pathAndSearch.startsWith('/api/')) {
          return nativeFetch(new Request(input, withCredentials(init)));
        }
      }
      return nativeFetch(input, init);
    };
    window.fetch = dispatch;
  } else {
    // No API base redirect — only normalize credentials on API calls.
    const dispatch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      if (typeof input === 'string') {
        if (shouldRedirectPath(input)) {
          return nativeFetch(input, withCredentials(init));
        }
        if (input.startsWith(`${DEFAULT_WEB_API_URL}/api/`)) {
          return nativeFetch(input, withCredentials(init));
        }
      }
      if (input instanceof URL) {
        const pathAndSearch = `${input.pathname}${input.search}`;
        if ((input.origin === window.location.origin || input.origin === DEFAULT_WEB_API_URL)
            && (shouldRedirectPath(pathAndSearch) || pathAndSearch.startsWith('/api/'))) {
          return nativeFetch(input, withCredentials(init));
        }
      }
      if (input instanceof Request) {
        const u = new URL(input.url);
        const pathAndSearch = `${u.pathname}${u.search}`;
        if ((u.origin === window.location.origin || u.origin === DEFAULT_WEB_API_URL)
            && (shouldRedirectPath(pathAndSearch) || pathAndSearch.startsWith('/api/'))) {
          return nativeFetch(new Request(input, withCredentials(init)));
        }
      }
      return nativeFetch(input, init);
    };
    window.fetch = dispatch;
  }

  (window as unknown as Record<string, unknown>).__wmWebRedirectPatched = true;
}
