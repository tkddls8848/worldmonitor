import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { __testing__ as health } from '../api/health.js';
import {
  WORKER_ACTIVATION_KEY,
  WORKER_META_KEY,
  WORKER_STATUS_KEY,
} from '../scripts/shipping-webhook-worker.mjs';

const now = 1_800_000_000_000;

function classify({ strlen, meta, activated }) {
  return health.classifyKey(
    'shippingWebhookWorker',
    WORKER_STATUS_KEY,
    { allowOnDemand: true },
    {
      keyStrens: new Map([[WORKER_STATUS_KEY, strlen]]),
      keyErrors: new Map(),
      keyMetaValues: new Map([[WORKER_META_KEY, meta == null ? null : JSON.stringify(meta)]]),
      keyMetaErrors: new Map(),
      activationStates: new Map([['shippingWebhookWorker', activated]]),
      now,
    },
  ).status;
}

describe('shipping webhook worker deployment registration', () => {
  it('registers health keys the worker writes', () => {
    assert.equal(health.STANDALONE_KEYS.shippingWebhookWorker, WORKER_STATUS_KEY);
    assert.deepEqual(health.SEED_META.shippingWebhookWorker, {
      key: WORKER_META_KEY,
      maxStaleMin: 15,
      activationKey: WORKER_ACTIVATION_KEY,
      cutover: { mode: 'activation-marker', fromKey: null, issue: 9217, activationKey: WORKER_ACTIVATION_KEY },
    });
    assert.equal(health.ON_DEMAND_KEYS.has('shippingWebhookWorker'), true);
    assert.equal(health.ACTIVATION_MARKERS.shippingWebhookWorker, WORKER_ACTIVATION_KEY);
  });

  it('softens only the pre-activation window and accepts zero subscribers while fresh', () => {
    assert.equal(classify({ strlen: 0, meta: null, activated: false }), 'EMPTY_ON_DEMAND');
    assert.equal(classify({ strlen: 0, meta: null, activated: true }), 'EMPTY');
    const fresh = { fetchedAt: now - 60_000, recordCount: 0, sourceState: 'ok' };
    assert.equal(classify({ strlen: 80, meta: fresh, activated: true }), 'OK');
    assert.equal(classify({ strlen: 80, meta: { ...fresh, fetchedAt: now - 16 * 60_000 }, activated: true }), 'STALE_SEED');
    assert.equal(classify({ strlen: 80, meta: { ...fresh, recordCount: 3, sourceState: 'error' }, activated: true }), 'SEED_ERROR');
  });
});
