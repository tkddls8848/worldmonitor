import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import correlationRuntimeModeHandler from '../api/correlation-runtime-mode.js';
import securityReportHandler from '../api/security/report.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

const agentDiscovery = read('docs/agent-discovery.mdx');
const apiPlatform = read('docs/api-platform.mdx');
const mcpOverview = read('docs/mcp-overview.mdx');
const apiOauth = read('docs/api-oauth.mdx');
const mcpErrors = read('docs/mcp-error-catalog.mdx');
const usageErrors = read('docs/usage-errors.mdx');

describe('API documentation stays aligned with runtime policy boundaries', () => {

  it('separates the wildcard-CORS reporting sink from origin-gated operational routes', async () => {
    const reportPreflight = await securityReportHandler(new Request('https://worldmonitor.app/api/security/report', {
      method: 'OPTIONS',
      headers: { Origin: 'https://untrusted.example' },
    }));
    assert.equal(reportPreflight.status, 204);
    assert.equal(reportPreflight.headers.get('Access-Control-Allow-Origin'), '*');

    const hostileRequest = () => new Request('https://worldmonitor.app/api/internal', {
      headers: { Origin: 'https://untrusted.example' },
    });
    for (const handler of [correlationRuntimeModeHandler]) {
      const response = await handler(hostileRequest());
      assert.equal(response.status, 403);
      assert.equal(response.headers.get('Access-Control-Allow-Origin'), null);
    }

    assert.match(apiPlatform, /`POST \/api\/security\/report`[\s\S]*?wildcard CORS/i);
    assert.match(apiPlatform, /analytics-health[\s\S]*?correlation-runtime-mode[\s\S]*?origin-gated/i);
    assert.doesNotMatch(apiPlatform, /Internal ops surfaces[^\n]*origin-gated/i);
  });

  it('does not describe confirmed-lapse OAuth identities as revoked', () => {
    for (const doc of [mcpOverview, apiOauth]) {
      assert.match(doc, /provider-confirmed[\s\S]{0,220}(?:restricted|allowance-metered)[\s\S]{0,80}free-account/i);
      assert.match(doc, /expired or disabled[\s\S]{0,180}(?:denied|deny)/i);
      assert.doesNotMatch(doc, /(?:subscription )?downgrade revokes (?:OAuth )?MCP access/i);
      assert.doesNotMatch(doc, /a downgrade revokes access on the next request/i);
    }
  });

  it('distinguishes public bot-gate bypasses from shared-secret machine routes', () => {
    assert.match(usageErrors, /Exact bot-gate bypass paths/i);
    assert.match(usageErrors, /intentionally public[\s\S]*\/api\/version[\s\S]*\/api\/download\.md/i);
    assert.match(usageErrors, /\/api\/seed-contract-probe[\s\S]*x-probe-secret: \$RELAY_SHARED_SECRET/i);
    assert.match(usageErrors, /\/api\/internal\/brief-why-matters[\s\S]*Authorization: Bearer \$RELAY_SHARED_SECRET/i);
    assert.doesNotMatch(usageErrors, /Exact public paths/i);
  });
});
