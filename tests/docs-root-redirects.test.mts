import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  ROOTLESS_DOC_REDIRECTS,
  buildRootlessDocsRedirects,
  getRootlessDocsDestination,
} from '../src/config/docs-root-redirects.ts';

describe('rootless Mintlify route canonicalization', () => {
  it('derives current and future routes from docs navigation and aliases', () => {
    const routes = buildRootlessDocsRedirects({
      navigation: {
        tabs: [{
          groups: [{
            pages: [
              'future-page',
              { group: 'Nested', pages: ['future-section/future-page'] },
            ],
          }],
        }],
      },
      redirects: [{ source: '/old-future-page', destination: '/future-page' }],
    });

    assert.equal(routes.get('/future-page'), 'https://www.worldmonitor.app/docs/future-page');
    assert.equal(
      routes.get('/future-section/future-page'),
      'https://www.worldmonitor.app/docs/future-section/future-page'
    );
    assert.equal(routes.get('/old-future-page'), 'https://www.worldmonitor.app/docs/future-page');
  });

  it('covers every published string page in docs.json without a hand-maintained allowlist', () => {
    for (const path of [
      '/api-brief',
      '/mcp-tools-reference',
      '/architecture',
      '/methodology/chokepoints',
      '/panels/forecast',
    ]) {
      assert.ok(ROOTLESS_DOC_REDIRECTS.has(path), `missing generated docs route ${path}`);
    }
    assert.ok(ROOTLESS_DOC_REDIRECTS.size > 200, 'expected the complete Mintlify navigation, not a remediation list');
  });

  it('defers Vercel-owned first segments that also appear in the docs map', () => {
    // #6575: the SPA catch-all lookahead this used to parse is gone. Pin the
    // product-owned roots from getRootlessDocsDestination's allowlist instead
    // of reconstructing them from a deleted rewrite.
    const vercelOwnedDocPaths = ['/about', '/changelog', '/contact', '/pricing', '/privacy', '/sandbox', '/support', '/terms'];
    assert.ok(ROOTLESS_DOC_REDIRECTS.has('/sandbox'), 'docs still publishes sandbox; owned-path must keep deferring it');

    for (const path of vercelOwnedDocPaths.filter((root) => ROOTLESS_DOC_REDIRECTS.has(root))) {
      assert.equal(
        getRootlessDocsDestination(path),
        null,
        `${path} is Vercel-owned and must not 308 to /docs`
      );
    }
  });
});
