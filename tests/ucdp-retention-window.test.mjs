// Deliberate constant pins by design (#8690, section 2; #8683): this suite
// pins the one-year Redis retention, two-year CII classification window,
// and separate relay page cap alongside their documentation.
// Runtime samples cannot establish these declared limits, and the failure
// messages require deliberate updates to the guard and docs together.
//
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';

const root = resolve(import.meta.dirname, '..');

function readRepoFile(path) {
  return readFileSync(resolve(root, path), 'utf8');
}

describe('UCDP retained window is intentionally smaller than CII classification window', () => {
  it('keeps the CII scorer on a two-year UCDP classification window', () => {
    const scorer = readRepoFile('server/worldmonitor/intelligence/v1/get-risk-scores.ts');

    assert.match(
      scorer,
      /const UCDP_CLASSIFICATION_WINDOW_MS = 2 \* 365 \* 24 \* 60 \* 60 \* 1000;/,
      'CII scoring must continue to classify UCDP over the two-year heuristic window',
    );
  });

  it('documents the relay reader page cap separately from Redis writer retention', () => {
    const relay = readRepoFile('scripts/personal-providers.cjs');
    const methodology = readRepoFile('docs/methodology/cii-risk-scores.mdx');
    const changelog = readRepoFile('docs/changelog.mdx');

    assert.match(
      relay,
      /const UCDP_RELAY_MAX_PAGES = 12;/,
      'public relay UCDP reader page cap changed; update docs deliberately',
    );
    assert.match(changelog, /newest six UCDP pages/); // Historical v8 release note.
    for (const doc of [methodology]) {
      assert.match(doc, /every monthly GED Candidate release/);
      assert.match(doc, /2,000 mapped events/);
      assert.match(doc, /365-day/);
      assert.match(doc, /12 pages/);
      assert.match(doc, /production API-volume and Redis-payload safeguards/);
    }
  });
});
