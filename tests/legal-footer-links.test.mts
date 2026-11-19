/**
 * The Terms are a browsewrap ("By using the Service, you agree to these
 * Terms") and a browsewrap is only as good as its link. #6976 found no Terms
 * or Privacy link in either production footer — the shared one on the welcome
 * and /pro pages, and the separate one the Enterprise page hand-rolls — and
 * none in the dashboard at all. (The issue calls the App.tsx footer "the /pro
 * pricing-page footer"; /pro actually renders the shared `<Footer />`, and that
 * second footer belongs to the `#enterprise` route. Both are covered.)
 *
 * The /pro and welcome pages were removed with pro-test/; what remains is the
 * shared legal cluster and the dashboard's own legal row, which is built at
 * runtime by `legalLinksHtml()` and asserted directly.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  EULA_PATH,
  LEGAL_FOOTER_LINKS,
  TERMS_PATH,
  LICENSE_PATH,
  TRADEMARK_PATH,
} from '../shared/legal.ts';
import { legalLinksHtml } from '../src/utils/legal-links.ts';

const REQUIRED = [EULA_PATH, TERMS_PATH, LICENSE_PATH, TRADEMARK_PATH];

describe('legal links are reachable in one click', () => {
  it('the shared cluster is every document a buyer is bound by', () => {
    assert.deepEqual(
      LEGAL_FOOTER_LINKS.map(link => link.path),
      REQUIRED,
    );
    for (const link of LEGAL_FOOTER_LINKS) {
      assert.ok(link.label.length > 0, `${link.path} needs a label`);
    }
  });

  it('the dashboard legal row carries the same four documents', () => {
    const html = legalLinksHtml('https://worldmonitor.app');
    for (const path of REQUIRED) {
      assert.ok(
        html.includes(`href="https://worldmonitor.app${path}"`),
        `dashboard legal row is missing ${path}`,
      );
    }
  });

  it('the dashboard legal row is absolute, so the desktop WebView resolves it', () => {
    // A root-relative /docs/terms inside Tauri resolves against the bundled
    // app origin and 404s — the one runtime where the link silently dies.
    const html = legalLinksHtml('https://worldmonitor.app');
    assert.ok(!/href="\/docs\//.test(html), 'legal row must not emit root-relative doc links');
  });

  it('the dashboard legal row opens externally without leaking the opener', () => {
    const html = legalLinksHtml('https://worldmonitor.app');
    const anchors = html.match(/<a\b[^>]*>/g) ?? [];
    assert.equal(anchors.length, REQUIRED.length);
    for (const anchor of anchors) {
      assert.match(anchor, /rel="noopener noreferrer"/, `missing rel on ${anchor}`);
      assert.match(anchor, /target="_blank"/, `missing target on ${anchor}`);
    }
  });
});
