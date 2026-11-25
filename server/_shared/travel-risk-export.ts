/**
 * The in-app export of the travel risk assessment (#10451, phase 2):
 * POST /api/travel-risk-assessment, wired in api/travel-risk-assessment.ts.
 *
 * The draft is the one the MCP tool returns. This route runs the tool's own
 * `_execute`, so the two surfaces cannot drift, and returns it as a file
 * (Markdown, or HTML that Word opens and that prints to PDF).
 *
 * The personal server uses a single owner identity for exports.
 *
 * Nothing is stored. The request carries countries, cities and dates only, as
 * the tool does; `parseTravelRiskArgs` refuses every other field and names the
 * field, never the value, so nothing a caller typed is echoed into a response
 * or a log line. The response is `no-store`.
 */

import { RpcValidationError } from '../../api/mcp/billing-denial';
import type { TravelRiskResult } from '../../api/mcp/registry/_travel-risk-document';
import { parseTravelRiskArgs } from '../../api/mcp/registry/travel-risk-tool';
import { McpSourceUnavailableError } from '../../api/mcp/source-unavailable';
import { renderTravelRiskHtml } from './travel-risk-html';

export const TRAVEL_RISK_EXPORT_MAX_BODY_BYTES = 8_192;

export type TravelRiskExportFormat = 'markdown' | 'html';

export interface TravelRiskExportDeps {
  corsHeaders(request: Request): Record<string, string>;
  build(params: Record<string, unknown>): Promise<TravelRiskResult>;
  now(): number;
  captureError(error: unknown, context: { step: string }): void;
}

const FORMATS: Record<TravelRiskExportFormat, { type: string; extension: string }> = {
  markdown: { type: 'text/markdown; charset=utf-8', extension: 'md' },
  html: { type: 'text/html; charset=utf-8', extension: 'html' },
};

function json(body: unknown, status: number, cors: Record<string, string>, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...cors, ...extra },
  });
}

/** The body as text, or null as soon as it passes `maxBytes`; the unread rest is cancelled. */
async function readBodyWithin(request: Request, maxBytes: number): Promise<string | null> {
  if (!request.body) return '';
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export function createTravelRiskExportHandler(deps: TravelRiskExportDeps): (request: Request) => Promise<Response> {
  return async function handle(request: Request): Promise<Response> {
    const cors = deps.corsHeaders(request);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, cors, { Allow: 'POST, OPTIONS' });

    const nowMs = deps.now();

    const declared = Number(request.headers.get('Content-Length'));
    if (Number.isFinite(declared) && declared > TRAVEL_RISK_EXPORT_MAX_BODY_BYTES) {
      return json({ error: 'PAYLOAD_TOO_LARGE' }, 413, cors);
    }
    // A chunked upload declares no length, so the cap has to hold while the body
    // is read: stop at the cap and cancel the rest rather than drain it first.
    const text = await readBodyWithin(request, TRAVEL_RISK_EXPORT_MAX_BODY_BYTES);
    if (text === null) return json({ error: 'PAYLOAD_TOO_LARGE' }, 413, cors);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return json({ error: 'INVALID_JSON' }, 400, cors);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'INVALID_JSON' }, 400, cors);
    const { format, ...params } = body as Record<string, unknown>;
    if (format !== 'markdown' && format !== 'html') {
      return json({
        error: 'INVALID_ARGUMENTS',
        violations: [{ field: 'format', description: 'Use "markdown" or "html".' }],
      }, 400, cors);
    }

    try {
      // Validates first, so a rejected trip costs no source read.
      parseTravelRiskArgs(params);
      const result = await deps.build(params);
      const { type, extension } = FORMATS[format];
      const content = format === 'html' ? renderTravelRiskHtml(result.markdown) : result.markdown;
      const stamp = new Date(nowMs).toISOString().slice(0, 10);
      return new Response(content, {
        status: 200,
        headers: {
          'Content-Type': type,
          // Fixed name: a task label or a country is trip detail, and file names
          // end up in downloads folders, sync clients and recent-file lists.
          'Content-Disposition': `attachment; filename="travel-risk-assessment-${stamp}.${extension}"`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
          // The document needs inline styles and nothing else.
          'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; sandbox",
          ...cors,
        },
      });
    } catch (error) {
      if (error instanceof RpcValidationError) {
        return json({ error: 'INVALID_ARGUMENTS', violations: error.violations }, 400, cors);
      }
      if (error instanceof McpSourceUnavailableError) {
        return json({ error: 'SOURCES_UNAVAILABLE' }, 503, cors, { 'Retry-After': '60' });
      }
      deps.captureError(error, { step: 'build' });
      return json({ error: 'INTERNAL_ERROR' }, 500, cors);
    }
  };
}
