import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { VARIANT_META } from '../src/config/variant-meta.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function source(relativePath) {
  return readFileSync(resolve(root, relativePath), 'utf8');
}

function assertDescription(label, description) {
  assert.equal(typeof description, 'string', `${label} must have a description`);
  assert.ok(
    description.length >= 150 && description.length <= 160,
    `${label} description must be 150-160 characters, got ${description.length}`,
  );
}

function assertTitle(label, title) {
  assert.equal(typeof title, 'string', `${label} must have a title`);
  assert.ok(title.length <= 60, `${label} title must be at most 60 characters, got ${title.length}`);
}

describe('reported landing-page SEO metadata', () => {
  it('keeps blog landing metadata within search-friendly bounds', () => {
    const blogIndex = source('blog-site/src/pages/index.astro');
    const authorPage = source('blog-site/src/pages/authors/elie-habib.astro');
    const glossaryIndex = source('blog-site/src/pages/glossary/index.astro');
    const glossaryTerm = source('blog-site/src/pages/glossary/[slug].astro');

    const blogTitle = blogIndex.match(/metaTitle="([^"]+)"/)?.[1];
    const blogDescription = blogIndex.match(/<Base\s+[\s\S]*?description="([^"]+)"/)?.[1];
    const authorDescription = authorPage.match(/const description = '([^']+)'/)?.[1];
    const glossaryDescription = glossaryIndex.match(/<Base\s+[\s\S]*?description="([^"]+)"/)?.[1];

    assertTitle('blog index', blogTitle);
    assertDescription('blog index', blogDescription);
    assertDescription('Elie Habib author archive', authorDescription);
    assertDescription('glossary index', glossaryDescription);
    assert.match(
      glossaryTerm,
      /const metaTitle = term\.abbr[\s\S]*?\$\{term\.abbr\} Definition \| World Monitor/,
      'abbreviated glossary terms must use compact definition titles',
    );
  });

  it('keeps the documentation sandbox descriptions bounded', () => {
    const englishSandbox = source('docs/sandbox.mdx');
    const sandbox = source('docs/zh/sandbox.mdx');

    const englishSandboxDescription = englishSandbox.match(/^description:\s*"([^"]+)"$/m)?.[1];
    const sandboxDescription = sandbox.match(/^description:\s*"([^"]+)"$/m)?.[1];

    assertDescription('English sandbox', englishSandboxDescription);
    assertDescription('Chinese sandbox', sandboxDescription);
  });

  it('keeps full and variant dashboard descriptions bounded and synchronized', () => {
    const indexHtml = source('index.html');
    const variants = ['full', 'finance', 'commodity',  'energy'];

    for (const variant of variants) {
      assertDescription(`${variant} variant`, VARIANT_META[variant].description);
    }

    const fullDescription = indexHtml.match(/<meta name="description" content="([^"]+)"/)?.[1];
    assert.equal(fullDescription, VARIANT_META.full.description, 'index.html must use the full variant description');
  });

  it('keeps every variant dashboard title within 60 characters and free of em dashes', () => {
    for (const [variant, meta] of Object.entries(VARIANT_META)) {
      assertTitle(`${variant} variant`, meta.title);
      assert.equal(meta.title.includes('\u2014'), false, `${variant} title includes an em dash`);
    }
  });
});
