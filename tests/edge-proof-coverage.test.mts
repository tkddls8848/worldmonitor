import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

const originalFetch = globalThis.fetch;

import {
  hasUnprovenCloudflareClientIp as serverUnproven,
  hasCloudflareTransitProof as serverProof,
  getClientIp as getServerClientIp,
  resetEdgeProofMismatchWarnedForTest as resetServer,
} from '../server/_shared/client-ip.ts';
import {
  hasUnprovenCloudflareClientIp as apiUnproven,
  hasCloudflareTransitProof as apiProof,
  getClientIp as getApiClientIp,
  resetEdgeProofMismatchWarnedForTest as resetApi,
} from '../api/_client-ip.js';

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.CF_EDGE_PROOF_SECRET;
  delete process.env.UPSTASH_REDIS_REST_URL;
  delete process.env.UPSTASH_REDIS_REST_TOKEN;
  resetServer();
  resetApi();
});

function requestWith(headers) {
  return new Request('https://worldmonitor.app/api/skills/fetch-agentskills', { headers });
}

describe('unproven Cloudflare client IP (#8402)', () => {
  it('is false when the edge-proof secret is unset', () => {
    const req = requestWith({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '192.0.2.5',
    });
    assert.equal(serverUnproven(req), false);
    assert.equal(apiUnproven(req), false);
  });

  it('is false for a true direct-origin request with no cf-connecting-ip', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = requestWith({ 'x-real-ip': '198.51.100.9' });
    assert.equal(serverUnproven(req), false);
    assert.equal(getServerClientIp(req), '198.51.100.9');
  });

  it('is true for a direct-to-Vercel spoof of cf-connecting-ip', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = requestWith({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '198.51.100.9',
      'x-wm-edge-proof': 'wrong',
    });
    assert.equal(serverUnproven(req), true);
    assert.equal(apiUnproven(req), true);
    assert.equal(serverProof(req), false);
    assert.equal(apiProof(req), false);
    // getClientIp still refuses the forged CF IP…
    assert.equal(getApiClientIp(req), '198.51.100.9');
  });

  it('is false when the Transform Rule proof matches', () => {
    process.env.CF_EDGE_PROOF_SECRET = 'edge-secret-xyz';
    const req = requestWith({
      'cf-connecting-ip': '203.0.113.7',
      'x-real-ip': '173.245.48.1',
      'x-wm-edge-proof': 'edge-secret-xyz',
    });
    assert.equal(serverUnproven(req), false);
    assert.equal(getServerClientIp(req), '203.0.113.7');
  });
});
