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

export function ownApiFeedRequest(
  feedUrl: string,
  env: Env = globalThis.process?.env ?? {},
): { url: string; headers: Record<string, string> } | null {
  if (!feedUrl.startsWith('/') || feedUrl.startsWith('//')) return null;
  const origin = env.LOCAL_API_ORIGIN;
  const token = env.LOCAL_API_TOKEN;
  if (!origin || !token) return null;
  return { url: `${origin.replace(/\/+$/, '')}${feedUrl}`, headers: { [LOCAL_API_TOKEN_HEADER]: token } };
}

export function isOwnApiFeed(feedUrl: string): boolean {
  return feedUrl.startsWith('/') && !feedUrl.startsWith('//');
}
