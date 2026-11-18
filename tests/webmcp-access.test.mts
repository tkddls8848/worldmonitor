import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACCESS_CONTEXT_PRIVACY_KEYS,
  buildWebMcpAccessContext,
} from '../src/services/webmcp-access-snapshot.ts';
import { boundWebMcpAccessContext } from '../src/services/webmcp.ts';

function assertNoPersonalInformation(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of ACCESS_CONTEXT_PRIVACY_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(value as object, key),
      false,
      `access context must not expose ${key}`,
    );
  }
  assert.doesNotMatch(serialized, /ada@example\.com/i);
  assert.doesNotMatch(serialized, /Ada Lovelace/);
  assert.doesNotMatch(serialized, /user_secret_id/);
  assert.doesNotMatch(serialized, /pk_test_|sk_live_|Bearer /);
}

describe('buildWebMcpAccessContext', () => {
  it('reports every capability open and nothing capped, with no account', () => {
    const snapshot = buildWebMcpAccessContext({ enabledPanelUsed: 12, dashboardTabCount: 1 });
    assert.equal(snapshot.accountState, 'signed_out');
    assert.equal(snapshot.clerk, 'unavailable');
    assert.equal(snapshot.productTier, 'pro');
    assert.deepEqual(snapshot.capabilities, {
      premiumAccess: true,
      apiAccess: false,
      mcpAccess: false,
      dataExport: true,
    });
    assert.deepEqual(snapshot.limits, {
      enabledPanels: { used: 12, cap: null },
      dashboardTabs: { used: 1, cap: null, canCreate: true },
    });
    assertNoPersonalInformation(snapshot);
  });

  it('clamps counts to non-negative integers', () => {
    const snapshot = buildWebMcpAccessContext({ enabledPanelUsed: -3, dashboardTabCount: Number.NaN });
    assert.equal(snapshot.limits.enabledPanels.used, 0);
    assert.equal(snapshot.limits.dashboardTabs.used, 0);
  });

  it('never copies personal fields even when a caller tries to inject them', () => {
    const snapshot = buildWebMcpAccessContext({ enabledPanelUsed: 12, dashboardTabCount: 1 });
    const bounded = boundWebMcpAccessContext({
      ...snapshot,
      email: 'ada@example.com',
      name: 'Ada Lovelace',
      userId: 'user_secret_id',
      token: 'sess_abc',
      sessionId: 'sess_abc',
    } as typeof snapshot & Record<string, string>, true);
    assertNoPersonalInformation(bounded);
    assert.equal(bounded.targetCancellationSupported, true);
    assert.equal(
      Object.keys(bounded).sort().join(','),
      [
        'accountState',
        'capabilities',
        'clerk',
        'limits',
        'productTier',
        'targetCancellationSupported',
      ].sort().join(','),
    );
  });
});
