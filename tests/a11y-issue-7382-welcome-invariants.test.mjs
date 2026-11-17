// Text checks that stay (#8690, section 2) for the welcome-page a11y
// invariants from #7382. The parts the prerender renders (nav lockup,
// Launch CTA label, footer contrast, studio byline) now run against the
// built page in tests/pro-welcome-a11y-built.test.mjs. What remains here is
// outside the pro build: blog-site/src/layouts/Base.astro belongs to a
// separate Astro build that the test runners do not produce.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');

const read = (path) => readFileSync(resolve(root, path), 'utf8');

const blogBase = read('blog-site/src/layouts/Base.astro');

/** Marketing chrome that renders the WORLD MONITOR lockup. */
const LOCKUP_SOURCES = Object.entries({
  'blog-site/src/layouts/Base.astro': blogBase,
});

describe('welcome a11y invariants (#7382)', () => {
  it('carries no Someone.ceo studio byline in marketing chrome', () => {
    for (const [path, source] of LOCKUP_SOURCES) {
      assert.doesNotMatch(source, /Someone\.ceo/i, `${path} must not render the studio byline`);
      assert.doesNotMatch(source, /SOMEONE_CEO_URL/, `${path} must not import the studio URL`);
    }
  });
});
