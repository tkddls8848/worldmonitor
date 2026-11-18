// The personal server only routes bundled .js files, and build-sidecar-handlers
// bundles a standalone api/ route only when PERSONAL_EDGE_ENTRIES names it. A
// dashboard feature whose route is missing from the list answers "No local
// handler" on the personal server. The build script runs esbuild at import time,
// so the list is read from its source.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(root, rel), 'utf8');

function personalEdgeEntries() {
  const block = read('scripts/build-sidecar-handlers.mjs').match(/export const PERSONAL_EDGE_ENTRIES = \[([\s\S]*?)\];/);
  assert.ok(block, 'PERSONAL_EDGE_ENTRIES literal not found');
  return [...block[1].matchAll(/^\s*'([^']+)',/gm)].map((match) => match[1]);
}

describe('personal edge entries', () => {
  const entries = personalEdgeEntries();

  it('bundles the Trip Assessment route the dashboard dialog calls', () => {
    const endpoint = read('src/services/travel-risk-export.ts').match(/export const TRIP_ENDPOINT = '\/api\/([^']+)';/);
    assert.ok(endpoint, 'TRIP_ENDPOINT literal not found');
    assert.ok(entries.includes(`${endpoint[1]}.ts`), `api/${endpoint[1]}.ts must be a personal edge entry`);
  });

  it('names only existing routes, and every bundled output stays out of git', () => {
    assert.ok(entries.length > 0);
    for (const rel of entries) {
      assert.ok(existsSync(join(root, 'api', rel)), `api/${rel} must exist`);
      const output = `api/${rel.replace(/\.ts$/, '.js')}`;
      // `git check-ignore` exits 0 when the path is ignored.
      execFileSync('git', ['check-ignore', '-q', output], { cwd: root });
    }
  });
});
