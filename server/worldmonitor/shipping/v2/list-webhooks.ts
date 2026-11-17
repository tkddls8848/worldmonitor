import type {
  ServerContext,
  ListWebhooksRequest,
  ListWebhooksResponse,
  WebhookSummary,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

import { PERSONAL_OWNER_ID } from '../../../../shared/personal-owner.js';
import { readOwnerWebhooks } from './webhook-owner-index';
import {
  recordEventType,
  type WebhookRecord,
} from './webhook-shared';

export async function listWebhooks(
  _ctx: ServerContext,
  _req: ListWebhooksRequest,
): Promise<ListWebhooksResponse> {
  // HTTP Basic auth on the personal server is the only access control; every
  // webhook belongs to the single owner.
  const ownerHash = PERSONAL_OWNER_ID;
  const records = await readOwnerWebhooks(ownerHash);
  const webhooks: WebhookSummary[] = [];
  for (const value of records) {
    try {
      const record = JSON.parse(value) as WebhookRecord;
      if (record.ownerTag !== ownerHash) continue;
      webhooks.push({
        subscriberId: record.subscriberId,
        callbackUrl: record.callbackUrl,
        chokepointIds: record.chokepointIds,
        alertThreshold: record.alertThreshold,
        createdAt: record.createdAt,
        active: record.active,
        eventType: recordEventType(record),
        countries: Array.isArray(record.countries) ? record.countries : [],
        minLiveSignal: record.minLiveSignal ?? 0,
        // Stored keys only (the event's own inputSchema properties, defaults
        // applied). The generated type lists every repeated field, but proto3
        // JSON omits empty repeated fields, so the wire shape is the same.
        ...(record.scope ? { scope: record.scope as unknown as WebhookSummary['scope'] } : {}),
      });
    } catch {
      // skip malformed
    }
  }

  return { webhooks };
}
