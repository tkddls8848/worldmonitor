/**
 * A news-catalog feed whose URL is a path (e.g. "/api/miit-news") is served by
 * this fork's own API, not by a third party. The browser fetches it same-origin;
 * server-side the digest reaches the same handler through the local API in this
 * process. scripts/personal-server.mjs sets LOCAL_API_ORIGIN after the local API
 * listens, and the local API refuses any request without its per-process
 * LOCAL_API_TOKEN transport header (scripts/local/local-api-server.mjs).
 *
 * Without both values there is no local API to ask, and the feed is skipped
 * rather than sent anywhere else.
 */
export const LOCAL_API_TOKEN_HEADER = 'x-worldmonitor-local-token';

type Env = Record<string, string | undefined>;

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The local API origin, normalized, or null when it is not a plain loopback
 * http origin. The transport token is sent only there, never to another host.
 */
function loopbackOrigin(value: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' || !LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  return parsed.origin;
}

export function ownApiFeedRequest(
  feedUrl: string,
  env: Env = globalThis.process?.env ?? {},
): { url: string; headers: Record<string, string> } | null {
  if (!feedUrl.startsWith('/') || feedUrl.startsWith('//')) return null;
  const origin = env.LOCAL_API_ORIGIN ? loopbackOrigin(env.LOCAL_API_ORIGIN) : null;
  const token = env.LOCAL_API_TOKEN;
  if (!origin || !token) return null;
  return { url: `${origin}${feedUrl}`, headers: { [LOCAL_API_TOKEN_HEADER]: token } };
}

export function isOwnApiFeed(feedUrl: string): boolean {
  return feedUrl.startsWith('/') && !feedUrl.startsWith('//');
}
