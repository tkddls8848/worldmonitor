import {
  ApiError,
  type ListWebhooksRequest,
  type ListWebhooksResponse,
  type RegisterWebhookRequest,
  type RegisterWebhookResponse,
  type ServerContext,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

// The webhook subsystem (registration, delivery worker, management routes) was
// removed from the personal fork: its worker called the upstream operator's
// API. The generated service still declares these two RPCs (proto/ and
// src/generated/ stay frozen in Phase 1), so they answer 410 Gone.
const WEBHOOKS_RETIRED = 'Shipping webhooks are not available in this deployment';

export async function registerWebhook(_ctx: ServerContext, _req: RegisterWebhookRequest): Promise<RegisterWebhookResponse> {
  throw new ApiError(410, WEBHOOKS_RETIRED, '');
}

export async function listWebhooks(_ctx: ServerContext, _req: ListWebhooksRequest): Promise<ListWebhooksResponse> {
  throw new ApiError(410, WEBHOOKS_RETIRED, '');
}
