/**
 * Brief carousel image endpoint (Phase 8).
 *
 * GET /api/brief/carousel/{userId}/{issueSlot}/{page}
 *   -> 200 image/png   cover | threads | story page. Cache-Control
 *                      is public, max-age=604800 (7 days, matching the
 *                      Redis envelope TTL) and is NOT immutable.
 *                      CDN-Cache-Control and Vercel-CDN-Cache-Control
 *                      carry the same policy.
 *   -> 404 on Redis miss (no brief composed for that user/slot) or a
 *      userId other than the owner's
 *   -> 404 on invalid page (must be one of 0, 1, 2)
 *   -> 4xx/5xx always Cache-Control: no-store. NEVER returns a
 *      placeholder PNG — a 1x1 blank cached by Telegram + CDN is worse
 *      than a clean 503 that sendMediaGroup skips. The digest cron
 *      treats carousel failure as best-effort and still sends the
 *      long-form text message, and the next cron tick re-renders
 *      with a fresh cold start.
 *
 * Through the personal server’s loopback ingress, a `?t=`
 * token on older links is ignored. The only brief owner is
 * PERSONAL_OWNER_ID (shared/personal-owner.js).
 *
 * Runtime: Edge (via @vercel/og). Earlier attempts — direct satori +
 * @resvg/resvg-wasm and satori + @resvg/resvg-js native binding —
 * each hit a different Vercel bundler footgun (asset-URL refusal
 * on one path, nft missing the conditional native peer on the
 * other). @vercel/og is the first-party wrapper that handles both.
 * Cold start ~300ms, warm ~30ms.
 */

export const config = { runtime: 'edge' };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders, isDisallowedOrigin } from '../../../../_cors.js';
import { readRawJsonFromUpstash } from '../../../../_upstash-json.js';
import { PERSONAL_OWNER_ID } from '../../../../../shared/personal-owner.js';
import { renderCarouselImageResponse, pageFromIndex } from '../../../../../server/_shared/brief-carousel-render';

// The digest cron's slot format (YYYY-MM-DD-HHMM).
const ISSUE_DATE_RE = /^\d{4}-\d{2}-\d{2}-\d{4}$/;

function jsonError(
  msg: string,
  status: number,
  cors: Record<string, string>,
): Response {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...cors,
      'Cache-Control': 'no-store',
      'CDN-Cache-Control': 'no-store',
      'Vercel-CDN-Cache-Control': 'no-store',
    },
  });
}

// Matches the 7-day brief envelope TTL. @vercel/og's own Cache-Control is a year-long
// immutable default and is replaced after ImageResponse construction
// (passing it via extraHeaders appends a second Cache-Control).
const CAROUSEL_CACHE_CONTROL = 'public, max-age=604800';

function withCacheControl(response: Response, body: BodyInit | null): Response {
  const headers = new Headers(response.headers);
  headers.set('Cache-Control', CAROUSEL_CACHE_CONTROL);
  headers.set('CDN-Cache-Control', CAROUSEL_CACHE_CONTROL);
  headers.set('Vercel-CDN-Cache-Control', CAROUSEL_CACHE_CONTROL);
  return new Response(body, { status: response.status, headers });
}

export default async function handler(req: Request): Promise<Response> {
  if (isDisallowedOrigin(req)) {
    return new Response('Origin not allowed', {
      status: 403,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const cors = getCorsHeaders(req, 'GET, OPTIONS') as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: cors });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return jsonError('Method not allowed', 405, { ...cors, Allow: 'GET, HEAD, OPTIONS' });
  }

  const url = new URL(req.url);
  const parts = url.pathname.split('/').filter(Boolean);
  // parts = ['api', 'brief', 'carousel', userId, issueSlot, page]
  if (parts.length < 6) return jsonError('bad_path', 400, cors);
  const userId = parts[3]!;
  const issueDate = parts[4]!;
  const pageRaw = parts[5]!;

  if (!ISSUE_DATE_RE.test(issueDate)) return jsonError('invalid_issue_date', 400, cors);

  const pageIdx = Number.parseInt(pageRaw, 10);
  const page = pageFromIndex(pageIdx);
  if (!page) return jsonError('invalid_page', 404, cors);

  if (userId !== PERSONAL_OWNER_ID) return jsonError('not_found', 404, cors);

  let envelope;
  try {
    // Seeder-owned envelope (#7674): the Railway digest composer writes the
    // per-user brief envelope key bare — read it raw in every environment.
    envelope = await readRawJsonFromUpstash(`brief:${userId}:${issueDate}`, 3_000, true);
  } catch (err) {
    console.error('[api/brief/carousel] Upstash read failed:', (err as Error).message);
    return jsonError('service_unavailable', 503, cors);
  }
  if (!envelope) return jsonError('not_found', 404, cors);

  // @vercel/og sets Cache-Control to
  // `public, immutable, no-transform, max-age=31536000` and extraHeaders
  // append rather than replace it. Rebuild the Response below so the
  // 7-day policy is the only Cache-Control a shared cache sees.
  const extraHeaders: Record<string, string> = {
    ...cors,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  };

  try {
    const response = await renderCarouselImageResponse(envelope, page, extraHeaders);
    if (req.method === 'HEAD') {
      // ImageResponse doesn't expose a HEAD mode, so echo the status
      // and headers without the body. Telegram's preflight + CDN
      // validation both respect this.
      return withCacheControl(response, null);
    }
    return withCacheControl(response, response.body);
  } catch (err) {
    // AbortSignal.timeout / AbortController.abort firing somewhere inside
    // `renderCarouselImageResponse` (remote image fetch, font load, OG
    // generation) surfaces as `DOMException` / `TimeoutError` / `AbortError`.
    // The handler already returns 503 to the client; downgrade the Sentry
    // capture to `warning` so single transient timeouts don't drown real
    // render-pipeline regressions (font missing, image source broken, layout
    // bug). Non-timeout errors stay at default `error` level. Pattern mirrors
    // PR #3660's MCP dispatcher gate. WORLDMONITOR-QJ.
    const errName = err instanceof Error ? err.name : '';
    const isTransientTimeout = errName === 'AbortError' || errName === 'TimeoutError';
    const log = isTransientTimeout ? console.warn : console.error;
    log(
      `[api/brief/carousel] render failed for ${userId}/${issueDate}/${page}:`,
      (err as Error).message,
    );
    return jsonError('render_failed', 503, cors);
  }
}
