/**
 * In-app export of the travel risk assessment (#10451, phase 2).
 *
 * POST /api/travel-risk-assessment
 * Body: { countries: [{ country_code, cities?, arrive?, depart? }], date_from?, date_to?, task_label?, format: 'markdown' | 'html' }
 * Auth: the personal server's HTTP Basic auth; the caller is always the owner.
 *
 * Returns the draft as a file attachment, text/markdown or text/html. The
 * logic is in server/_shared/travel-risk-export.ts so it can be tested without
 * the edge runtime. Nothing is stored.
 */

export const config = { runtime: 'edge', regions: ['iad1', 'lhr1', 'fra1', 'sfo1'] };

// @ts-expect-error — JS module, no declaration file
import { getCorsHeaders } from './_cors.js';
// @ts-expect-error — JS module, no declaration file
import { captureSilentError } from './_sentry-edge.js';
import { createTravelRiskExportHandler } from '../server/_shared/travel-risk-export';
import { createTravelRiskTool } from './mcp/registry/travel-risk-tool';
import type { TravelRiskResult } from './mcp/registry/_travel-risk-document';

const tool = createTravelRiskTool();

export default createTravelRiskExportHandler({
  corsHeaders: (request) => getCorsHeaders(request, 'POST, OPTIONS'),
  build: async (params) => {
    if (!tool._execute) throw new Error('travel risk tool has no executor');
    return await tool._execute(params, '', { kind: 'free' }, undefined as never) as TravelRiskResult;
  },
  now: () => Date.now(),
  captureError: (error, context) => {
    captureSilentError(error, {
      tags: { route: 'api/travel-risk-assessment', step: context.step },
      fingerprint: ['api/travel-risk-assessment', context.step, error instanceof Error ? error.name : 'Error'],
    });
  },
});
