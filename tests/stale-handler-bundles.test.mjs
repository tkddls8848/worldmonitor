// build-sidecar-handlers writes api/<domain>/v<N>/[rpc].js next to each
// [rpc].ts. Deleting a domain's source leaves its gitignored bundle behind, and
// the local API server routes every .js under api/, so the deleted endpoint
// would keep answering. The build removes such orphaned bundles.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findStaleHandlerBundles } from '../scripts/lib/stale-handler-bundles.mjs';

function fixture(files) {
  const dir = mkdtempSync(join(tmpdir(), 'wm-stale-bundles-'));
  for (const rel of files) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), '');
  }
  return dir;
}

describe('findStaleHandlerBundles', () => {
  it('reports a domain bundle whose [rpc].ts source is gone, and only that', () => {
    const dir = fixture([
      'market/v1/[rpc].ts',
      'market/v1/[rpc].js',
      'leads/v1/[rpc].js',
      'feedback/v1/[rpc].js',
      'v2/shipping/[rpc].ts',
      '[[...path]].js',
      'bootstrap.js',
    ]);
    try {
      const stale = findStaleHandlerBundles(dir).map((file) => file.slice(dir.length + 1).replace(/\\/g, '/')).sort();
      assert.deepEqual(stale, ['feedback/v1/[rpc].js', 'leads/v1/[rpc].js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns nothing for a missing api directory', () => {
    assert.deepEqual(findStaleHandlerBundles(join(tmpdir(), 'wm-no-such-api-dir')), []);
  });
});
