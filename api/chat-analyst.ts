/**
 * Streaming chat analyst for the personal server’s single owner.
 *
 * POST /api/chat-analyst
 * Body: { history: {role,content}[], query: string, domainFocus?: string, geoContext?: string }
 *
 * Returns text/event-stream SSE:
 *   data: {"meta":{"sources":["Brief","Risk",...],"degraded":false}}  — always first event
 *   data: {"action":{"type":"open_panel"|"set_view"|"...","label":"..."}}  — optional, schema-validated in-app actions
 *   data: {"delta":"..."}    — one per content token
 *   data: {"done":true}      — terminal event
 *   data: {"error":"..."}    — on auth/llm failure
 */

export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
import { PERSONAL_OWNER_ID } from '../shared/personal-owner.js';
import { assembleAnalystContext } from '../server/worldmonitor/intelligence/v1/chat-analyst-context';
import { buildAnalystMessages } from '../server/worldmonitor/intelligence/v1/chat-analyst-prompt';
import { buildActionEvents } from '../server/worldmonitor/intelligence/v1/chat-analyst-actions';
import { withPriceGrounding } from '../server/worldmonitor/intelligence/v1/chat-analyst-grounding';
import { callLlmReasoningStream } from '../server/_shared/llm';
import { getAiRoutingDecisionForUser, toLlmRoutingPolicy } from '../server/_shared/ai-routing-policy';
import { sanitizeForPrompt } from '../server/_shared/llm-sanitize.js';

const MAX_QUERY_LEN = 500;
const MAX_HISTORY_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 800;
const MAX_GEO_LEN = 2;
const VALID_DOMAINS = new Set(['all', 'geo', 'market', 'military', 'economic']);

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ChatAnalystRequestBody {
  history?: unknown[];
  query?: unknown;
  domainFocus?: unknown;
  geoContext?: unknown;
}

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors },
  });
}

function prependSseEvents(
  events: Array<Record<string, unknown>>,
  stream: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  const prefixes = events.map((e) => enc.encode(`data: ${JSON.stringify(e)}\n\n`));
  let innerReader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  let outerCancelled = false;
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for (const p of prefixes) controller.enqueue(p);
        innerReader = stream.getReader();
        while (true) {
          const { done, value } = await innerReader.read();
          if (done) break;
          controller.enqueue(value);
        }
        if (!outerCancelled) controller.close();
      } catch (err) {
        if (!outerCancelled) controller.error(err);
      }
    },
    async cancel(reason) {
      outerCancelled = true;
      await innerReader?.cancel(reason);
    },
  });
}

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req) as Record<string, string>;

  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        ...corsHeaders,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-WorldMonitor-Key, X-Api-Key',
      },
    });
  }

  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405, { ...corsHeaders, Allow: 'POST, OPTIONS' });
  }

  // Top-level error boundary. An edge function must never let an exception
  // escape: an uncaught throw becomes an opaque Vercel platform 500 that — for
  // the cross-origin api.worldmonitor.app caller — also drops our CORS headers,
  // so the browser sees an opaque failure rather than a readable status. The
  // pre-stream context reads are network-backed, so capture server-side for a
  // real trace and return a CORS-correct transient 503 the panel can render.
  try {
    let body: ChatAnalystRequestBody;
    try {
      body = (await req.json()) as ChatAnalystRequestBody;
    } catch {
      return json({ error: 'Invalid JSON body' }, 400, corsHeaders);
    }

    const rawQuery = typeof body.query === 'string' ? body.query.trim().slice(0, MAX_QUERY_LEN) : '';
    if (!rawQuery) return json({ error: 'query is required' }, 400, corsHeaders);

    const query = sanitizeForPrompt(rawQuery);
    if (!query) return json({ error: 'query is required' }, 400, corsHeaders);

    // Validate domainFocus against the fixed domain set to prevent prompt injection
    const rawDomain = typeof body.domainFocus === 'string' ? body.domainFocus.trim() : '';
    const domainFocus = VALID_DOMAINS.has(rawDomain) ? rawDomain : 'all';

    const geoContext = typeof body.geoContext === 'string'
      ? body.geoContext.trim().toUpperCase().slice(0, MAX_GEO_LEN)
      : undefined;

    const rawHistory = Array.isArray(body.history) ? body.history : [];
    const history: ChatMessage[] = rawHistory
      .filter((m): m is ChatMessage => {
        if (!m || typeof m !== 'object') return false;
        const msg = m as Record<string, unknown>;
        return (msg.role === 'user' || msg.role === 'assistant') && typeof msg.content === 'string';
      })
      .slice(-MAX_HISTORY_MESSAGES)
      .map((m) => {
        const sanitized = sanitizeForPrompt(m.content.slice(0, MAX_MESSAGE_CHARS)) ?? '';
        return { role: m.role, content: sanitized };
      })
      .filter((m) => m.content.length > 0);

    // Build retrieval query with current turn FIRST so its keywords fill the
    // extraction cap before prior-turn terms. This ensures pivot words like
    // "Germany" in "What about Germany?" are never crowded out by a long
    // previous question. Prior turn backfills remaining slots for topic continuity.
    const prevUserTurn = history.filter((m) => m.role === 'user').slice(-1)[0]?.content ?? '';
    const retrievalQuery = prevUserTurn ? `${query} ${prevUserTurn}` : query;

    // Chat turns are the owner's own text: a restricted account streams only
    // from its allowed providers (ai-routing-policy.ts). The routing lookup
    // reads only the owner, so it runs alongside the context reads instead of
    // adding its round trip before the first streamed token.
    const [context, routingDecision] = await Promise.all([
      assembleAnalystContext(geoContext, domainFocus, retrievalQuery),
      getAiRoutingDecisionForUser(PERSONAL_OWNER_ID),
    ]);
    // Instructions in the system prompt, feed-derived context in the final user
    // turn next to the question: untrusted text never shares the system role.
    const messages = buildAnalystMessages({ context, domainFocus, history, query });
    const routingPolicy = toLlmRoutingPolicy(routingDecision);
    const llmStream = callLlmReasoningStream({
      messages,
      routingPolicy,
      maxTokens: 600,
      // 600 tokens cannot carry DeepSeek V4 Flash's hidden reasoning: with it
      // on, the model returned empty or cut answers (eval 2026-10-26; #9195
      // measured the same for deduct-situation). Reasoning off answers in ~5s.
      enableReasoning: false,
      temperature: 0.35,
      timeoutMs: 25_000,
      signal: req.signal,
      stage: 'chat-analyst',
    });

    // Always prepend a meta event so the client knows which sources are live
    // and whether context is degraded — before the first token arrives.
    // Optionally follows with an action event for visual/chart queries.
    //
    // Outermost, a price the answer states must appear in the user turn (the
    // live-context block plus the question): on 2026-10-27 the analyst gave an
    // "$80" Brent level that nothing in its context supported. Streamed tokens
    // cannot be retracted, so an unsupported figure gets a visible caveat before
    // the terminal event and is reported here so the miss rate is observable.
    const groundText = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
    const stream = withPriceGrounding(
      prependSseEvents(
        [
          { meta: { sources: context.activeSources, degraded: context.degraded } },
          ...buildActionEvents(query).map((a) => ({ action: a })),
        ],
        llmStream,
      ),
      groundText,
      (prices) => {
        console.warn(`[chat-analyst] answer stated prices absent from the live context: ${prices.join(', ')}`);
      },
    );

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-store',
        'X-Accel-Buffering': 'no',
        ...corsHeaders,
      },
    });
  } catch (err) {
    console.error('[chat-analyst] pre-stream failure', err);
    return json({ error: 'service_unavailable' }, 503, corsHeaders);
  }
}
