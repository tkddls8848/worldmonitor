// RUN WITH: `npm run test:data` OR `node --import=tsx --test tests/gateway-401-www-authenticate.test.mjs`.
//
// RFC 9728 §5.1 / #4840: REST gateway auth failures carry a `WWW-Authenticate`
// API-key challenge whose `resource_metadata` points at the REST resource
// metadata document for the request's host, so an agent learns the auth
// requirements from the rejection itself instead of hunting for the
// well-known document. MCP and /agent/auth retain their OAuth challenges.

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createDomainGateway } from '../server/gateway.ts';
import { apiKeyChallenge, protectedResourceMetadataUrl, wwwAuthHeader } from '../api/_www-authenticate.ts';
import { wwwAuthHeader as mcpWwwAuthHeader } from '../api/mcp/auth.ts';
import resourceMetadata from '../api/oauth-protected-resource.ts';

const VALID_KEY = 'www-authenticate-test-operator-key';
const MCP_CHALLENGE = 'Bearer realm="worldmonitor", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource"';
const APEX_CHALLENGE = 'ApiKey realm="worldmonitor", header="X-WorldMonitor-Key", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource/api"';

function gateway() {
  return createDomainGateway([
    {
      method: 'GET',
      path: '/api/seismology/v1/list-earthquakes',
      handler: async () => Response.json({ source: 'rpc' }),
    },
  ]);
}

describe('shared bearer challenge helper', () => {
  it('is the single definition the MCP transport re-exports', () => {
    assert.equal(mcpWwwAuthHeader, wwwAuthHeader);
    assert.equal(wwwAuthHeader('https://worldmonitor.app/.well-known/oauth-protected-resource'), MCP_CHALLENGE);
    assert.equal(
      wwwAuthHeader('https://worldmonitor.app/.well-known/oauth-protected-resource', 'invalid_token'),
      'Bearer realm="worldmonitor", error="invalid_token", resource_metadata="https://worldmonitor.app/.well-known/oauth-protected-resource"',
    );
  });

  it('derives the metadata URL from an allowed Host and falls back to the apex otherwise', () => {
    const req = (host) => new Request('https://worldmonitor.app/api/x', { headers: { host } });
    assert.equal(protectedResourceMetadataUrl(req('api.worldmonitor.app')), 'https://api.worldmonitor.app/.well-known/oauth-protected-resource');
    assert.equal(protectedResourceMetadataUrl(req('www.worldmonitor.app')), 'https://www.worldmonitor.app/.well-known/oauth-protected-resource');
    assert.equal(protectedResourceMetadataUrl(req('evil.com')), 'https://worldmonitor.app/.well-known/oauth-protected-resource');
    assert.equal(apiKeyChallenge(req('evil.com')), APEX_CHALLENGE);
  });
});

describe('REST gateway 401 challenge (#4840)', () => {
  const originalValidKeys = process.env.WORLDMONITOR_VALID_KEYS;
  afterEach(() => {
    if (originalValidKeys == null) delete process.env.WORLDMONITOR_VALID_KEYS;
    else process.env.WORLDMONITOR_VALID_KEYS = originalValidKeys;
  });

  it('a valid key still succeeds without a challenge', async () => {
    process.env.WORLDMONITOR_VALID_KEYS = VALID_KEY;
    const res = await gateway()(new Request('https://worldmonitor.app/api/seismology/v1/list-earthquakes', {
      headers: { 'X-WorldMonitor-Key': VALID_KEY },
    }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('www-authenticate'), null);
  });

});
