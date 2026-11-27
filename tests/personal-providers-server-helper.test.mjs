import { getRelayBaseUrl, getRelayHeaders } from '../server/_shared/personal-providers.ts';
/**
 * Tests for server/_shared/personal-providers.ts helper functions.
 * Uses dynamic import with environment variable stubbing.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Environment stub helpers ─────────────────────────────────────────────────

function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

// ─── Load relay module functions inline (avoids ESM import caching issues) ───

describe('personal adapter helpers', () => {
  it('reads the running API origin on every call', () => {
    withEnv({LOCAL_API_ORIGIN: undefined}, () => assert.equal(getRelayBaseUrl(), null));
    withEnv({LOCAL_API_ORIGIN: 'http://127.0.0.1:3001'}, () => assert.equal(getRelayBaseUrl(), 'http://127.0.0.1:3001/api/local-providers'));
  });
  it('keeps provider headers and authenticates only the internal hop', () => {
    withEnv({LOCAL_API_TOKEN: 'internal'}, () => {
      const headers = getRelayHeaders({Accept: 'text/xml', 'User-Agent': 'test', 'x-worldmonitor-local-token': 'wrong'});
      assert.equal(headers.Accept, 'text/xml');
      assert.equal(headers['User-Agent'], 'test');
      assert.equal(headers['x-worldmonitor-local-token'], 'internal');
      assert.equal(headers.Authorization, undefined);
    });
  });
});

describe('relay.ts — consumer import verification', () => {
  const consumers = [
    { file: 'server/worldmonitor/aviation/v1/_shared.ts', importPath: '../../../_shared/personal-providers' },
    { file: 'server/worldmonitor/intelligence/v1/_relay.ts', importPath: '../../../_shared/personal-providers' },
    { file: 'server/worldmonitor/maritime/v1/get-vessel-snapshot.ts', importPath: '../../../_shared/personal-providers' },
    { file: 'server/worldmonitor/market/v1/_shared.ts', importPath: '../../../_shared/personal-providers' },
    { file: 'server/worldmonitor/news/v1/list-feed-digest.ts', importPath: '../../../_shared/personal-providers' },
    { file: 'server/worldmonitor/military/v1/list-military-flights.ts', importPath: '../../../_shared/personal-providers' },
  ];

  for (const { file, importPath } of consumers) {
    it(`${file} imports from shared relay`, () => {
      const src = readFileSync(resolve(file), 'utf-8');
      assert.ok(
        src.includes(`from '${importPath}'`),
        `${file}: must import relay helpers from '${importPath}'`,
      );
    });
  }

  it('no local getRelayBaseUrl/getRelayHeaders/getRelayRequestHeaders definitions in server/ (except _shared/personal-providers.ts)', () => {
    const dupeFiles = [
      'server/worldmonitor/aviation/v1/_shared.ts',
      'server/worldmonitor/intelligence/v1/_relay.ts',
      'server/worldmonitor/maritime/v1/get-vessel-snapshot.ts',
      'server/worldmonitor/market/v1/_shared.ts',
      'server/worldmonitor/news/v1/list-feed-digest.ts',
      'server/worldmonitor/military/v1/list-military-flights.ts',
    ];
    for (const file of dupeFiles) {
      const src = readFileSync(resolve(file), 'utf-8');
      assert.ok(
        !src.includes('function getRelayBaseUrl'),
        `${file}: must not define local getRelayBaseUrl`,
      );
      assert.ok(
        !src.includes('function getRelayHeaders'),
        `${file}: must not define local getRelayHeaders`,
      );
      assert.ok(
        !src.includes('function getRelayRequestHeaders'),
        `${file}: must not define local getRelayRequestHeaders`,
      );
    }
  });

  it('military list-military-flights.ts uses getRelayBaseUrl() not raw WS_RELAY_URL + /opensky', () => {
    const src = readFileSync(resolve('server/worldmonitor/military/v1/list-military-flights.ts'), 'utf-8');
    assert.ok(
      !src.includes("process.env.WS_RELAY_URL + '/opensky'"),
      'military: must use getRelayBaseUrl() to avoid wss:// URL bug',
    );
    assert.ok(
      src.includes('getRelayBaseUrl()') && src.includes("'/opensky'"),
      'military: must use getRelayBaseUrl() for relay URL construction',
    );
  });

  it('api/_personal-providers.js has canonical version comment', () => {
    const src = readFileSync(resolve('api/_personal-providers.js'), 'utf-8');
    assert.ok(
      src.includes('canonical version at server/_shared/personal-providers.ts'),
      'api/_personal-providers.js must have comment pointing to canonical server-side implementation',
    );
  });
});
