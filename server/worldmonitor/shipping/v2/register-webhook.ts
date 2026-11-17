import type {
  ServerContext,
  RegisterWebhookRequest,
  RegisterWebhookResponse,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';
import {
  ApiError,
  ValidationError,
} from '../../../../src/generated/server/worldmonitor/shipping/v2/service_server';

import { PERSONAL_OWNER_ID } from '../../../../shared/personal-owner.js';
import { pruneOwnerWebhookIndex } from './webhook-owner-index';
import { isOccurrenceEvent, normalizeWebhookScope } from './webhook-scope';
import { runRedisPipeline } from '../../../_shared/redis';
import {
  ALL_INDEX_KEY,
  DEFAULT_EVENT_TYPE,
  MIN_LIVE_SIGNAL_MAX,
  RISK_SURGE_COUNTRIES,
  RISK_SURGE_EVENT_TYPE,
  VALID_EVENT_TYPES,
  WEBHOOK_TTL,
  VALID_CHOKEPOINT_IDS,
  assertCallbackUrlRegistrationSafe,
  generateSecret,
  generateSubscriberId,
  webhookKey,
  ownerIndexKey,
  type WebhookRecord,
} from './webhook-shared';

export const MAX_WEBHOOKS_PER_OWNER = 10;
// Admission and all writes share one Redis operation; a SCARD followed by a
// pipeline of writes would allow concurrent registrations to exceed the cap.
export const REGISTER_WEBHOOK_SCRIPT = [
  "if redis.call('SCARD', KEYS[2]) >= tonumber(ARGV[4]) or redis.call('SCARD', KEYS[4]) >= tonumber(ARGV[4]) then return 0 end",
  "redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])",
  "redis.call('SADD', KEYS[2], ARGV[2])",
  "redis.call('EXPIRE', KEYS[2], ARGV[3])",
  "redis.call('SADD', KEYS[4], ARGV[2])",
  "redis.call('EXPIRE', KEYS[4], ARGV[3])",
  "redis.call('SADD', KEYS[3], ARGV[2])",
  'return 1',
].join(' ');

export async function registerWebhook(
  _ctx: ServerContext,
  req: RegisterWebhookRequest,
): Promise<RegisterWebhookResponse> {
  const callbackUrl = (req.callbackUrl ?? '').trim();
  if (!callbackUrl) {
    throw new ValidationError([{ field: 'callbackUrl', description: 'callbackUrl is required' }]);
  }

  try {
    await assertCallbackUrlRegistrationSafe(callbackUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'callbackUrl is not allowed';
    throw new ValidationError([{ field: 'callbackUrl', description: message }]);
  }

  const chokepointIds = Array.isArray(req.chokepointIds) ? req.chokepointIds : [];
  const invalidCp = chokepointIds.find(id => !VALID_CHOKEPOINT_IDS.has(id));
  if (invalidCp) {
    throw new ValidationError([
      { field: 'chokepointIds', description: `Unknown chokepoint ID: ${invalidCp}` },
    ]);
  }

  // alert_threshold is `optional int32` (#3242 followup #4) — undefined means
  // the partner omitted the field, so apply the legacy default of 50. An
  // explicit 0 is preserved (deliver every alert). The 0..100 range is
  // normally enforced by buf.validate at the wire layer, but we re-enforce
  // it here so direct handler calls (internal jobs, test harnesses, future
  // transports that bypass buf.validate) can't store out-of-range values.
  const alertThreshold = req.alertThreshold ?? 50;
  if (alertThreshold < 0 || alertThreshold > 100) {
    throw new ValidationError([
      { field: 'alertThreshold', description: 'alertThreshold must be between 0 and 100' },
    ]);
  }

  // Event type and its scope come from shared/event-triggers.json. The wire
  // default keeps every pre-existing partner body meaning chokepoint alerts.
  const eventType = (req.eventType ?? '').trim() || DEFAULT_EVENT_TYPE;
  if (!VALID_EVENT_TYPES.has(eventType)) {
    throw new ValidationError([
      { field: 'eventType', description: `Unknown eventType: ${eventType}. Expected one of ${[...VALID_EVENT_TYPES].join(', ')}` },
    ]);
  }
  // Occurrence events (news.breaking, market.move) take their filters in
  // `scope`, validated against the event's inputSchema in the registry with
  // defaults stored on the record. Threshold events accept no scope.
  const scope = normalizeWebhookScope(eventType, req.scope);
  const countries = Array.isArray(req.countries)
    ? [...new Set(req.countries.map((code) => String(code).trim().toUpperCase()).filter(Boolean))]
    : [];
  if (eventType === RISK_SURGE_EVENT_TYPE) {
    const invalidCountry = countries.find((code) => !RISK_SURGE_COUNTRIES.has(code));
    if (invalidCountry) {
      throw new ValidationError([
        { field: 'countries', description: `Unmonitored country code: ${invalidCountry}` },
      ]);
    }
  } else if (countries.length) {
    throw new ValidationError([
      { field: 'countries', description: `countries applies only to ${RISK_SURGE_EVENT_TYPE}` },
    ]);
  }
  const minLiveSignal = req.minLiveSignal ?? 0;
  if (!Number.isInteger(minLiveSignal) || minLiveSignal < 0 || minLiveSignal > MIN_LIVE_SIGNAL_MAX) {
    throw new ValidationError([
      { field: 'minLiveSignal', description: `minLiveSignal must be an integer between 0 and ${MIN_LIVE_SIGNAL_MAX}` },
    ]);
  }
  if (minLiveSignal > 0 && eventType !== DEFAULT_EVENT_TYPE) {
    throw new ValidationError([
      { field: 'minLiveSignal', description: `minLiveSignal applies only to ${DEFAULT_EVENT_TYPE}` },
    ]);
  }

  // HTTP Basic auth on the personal server is the only access control; every
  // webhook belongs to the single owner.
  const ownerTag = PERSONAL_OWNER_ID;
  const quotaTag = ownerTag;
  await pruneOwnerWebhookIndex(ownerTag);
  const newSubscriberId = generateSubscriberId();
  const secret = await generateSecret();

  const record: WebhookRecord = {
    subscriberId: newSubscriberId,
    ownerTag,
    quotaTag,
    callbackUrl,
    chokepointIds: chokepointIds.length ? chokepointIds : [...VALID_CHOKEPOINT_IDS],
    alertThreshold,
    createdAt: new Date().toISOString(),
    active: true,
    secret,
    eventType,
    ...(eventType === RISK_SURGE_EVENT_TYPE ? { countries } : {}),
    ...(minLiveSignal > 0 ? { minLiveSignal } : {}),
    ...(isOccurrenceEvent(eventType) ? { scope } : {}),
  };

  const results = await runRedisPipeline([[
    'EVAL', REGISTER_WEBHOOK_SCRIPT, '4', webhookKey(newSubscriberId),
    ownerIndexKey(ownerTag), ALL_INDEX_KEY, ownerIndexKey(quotaTag),
    JSON.stringify(record), newSubscriberId, String(WEBHOOK_TTL), String(MAX_WEBHOOKS_PER_OWNER),
  ]]);
  if (results.length !== 1 || !results[0] || results[0].error
    || ![0, 1, '0', '1'].includes(results[0].result as number | string)) {
    throw new ApiError(503, 'Webhook registration could not be confirmed', '');
  }
  if (Number(results[0].result) === 0) {
    throw new ApiError(429, `Webhook limit reached (${MAX_WEBHOOKS_PER_OWNER}); delete an existing subscription before registering another`, '');
  }

  return { subscriberId: newSubscriberId, secret };
}
