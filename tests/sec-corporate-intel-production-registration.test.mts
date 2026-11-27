// Production registration for the retained SEC company registry.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

import {
  SEC_CIK_MAP_KEY,
  SEC_CIK_MAP_MAX_STALE_MIN,
  MIN_CIK_ENTRIES,
} from '../scripts/seed-sec-cik-map.mjs';
import {
  SEC_CIK_MAP_KEY as SERVER_CIK_KEY,
  SEC_CIK_MAP_MAX_STALE_MIN as SERVER_CIK_MAX_STALE_MIN,
} from '../server/_shared/sec-edgar';
import { __testing__ as healthTesting } from '../api/health.js';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('SEC corporate-intelligence production registration (#5695)', () => {
  it('shares canonical key names between seeders and server helpers', () => {
    assert.equal(SEC_CIK_MAP_KEY, 'intelligence:sec-cik-map:v1');
    assert.equal(SERVER_CIK_KEY, SEC_CIK_MAP_KEY);
  });

  it('schedules the registry in the market-backup bundle', () => {
    const bundle = read('scripts/seed-bundle-market-backup.mjs');
    assert.match(bundle, /script: 'seed-sec-cik-map\.mjs'[^}]*seedMetaKey: 'intelligence:sec-cik-map'[^}]*canonicalKey: 'intelligence:sec-cik-map:v1'/);
  });

  it('registers the registry with /api/health and keeps freshness budgets aligned', () => {
    assert.equal(healthTesting.STANDALONE_KEYS.secCikMap, SEC_CIK_MAP_KEY);

    const health = read('api/health.js');
    assert.match(
      health,
      /secCikMap:\s*\{ key: 'seed-meta:intelligence:sec-cik-map',\s*maxStaleMin: 2880, minRecordCount: 5000 \}/,
    );
    assert.equal(SEC_CIK_MAP_MAX_STALE_MIN, 2880, 'seeder and /api/health must publish the same CIK-map budget');
    assert.equal(SERVER_CIK_MAX_STALE_MIN, SEC_CIK_MAP_MAX_STALE_MIN, 'request-time CIK freshness must match seed health');
    assert.equal(MIN_CIK_ENTRIES, 5000, 'health minRecordCount mirrors the seeder validation floor');
  });

  it('rejects an empty CIK registry', () => {
    assert.equal(healthTesting.ZERO_RECORD_DATA_OK_KEYS.has('secCikMap'), false);
    assert.equal(healthTesting.EMPTY_DATA_OK_KEYS.has('secCikMap'), false);
  });

  it('keeps the seed-health sibling classifier in agreement (intervalMin = maxStaleMin / 2)', () => {
    const seedHealth = read('api/seed-health.js');
    assert.match(
      seedHealth,
      /'intelligence:sec-cik-map':\s*\{ key: 'seed-meta:intelligence:sec-cik-map', intervalMin: 1440, minRecordCount: 5000 \}/,
    );
  });

  it('documents the registry in the consolidation runbook', () => {
    const runbook = read('docs/railway-seed-consolidation-runbook.md');
    assert.match(runbook, /SEC CIK Map \(daily\)/);
  });

  it('keeps seeders inside scripts/ (nixpacks bundle constraint)', () => {
    for (const script of ['scripts/seed-sec-cik-map.mjs']) {
      const source = read(script);
      assert.doesNotMatch(source, /from '\.\.\/(server|src|shared|api)\//, `${script} must not import outside scripts/`);
    }
  });
});
