import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, it } from 'node:test';
import { load } from 'js-yaml';

describe('public agent documents', () => {
  // auth.md is intentionally heading-led for scanner compatibility. Its title,
  // description, and canonical identity are guarded in the dedicated auth suite.
  const files = readdirSync(new URL('../public/', import.meta.url)).filter(
    (file) => file.endsWith('.md') && file !== 'auth.md',
  );
  files.push('api/download.md');
  for (const file of files) {
    it(`${file} opens with document metadata`, () => {
      const document = readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');
      const frontmatter = document.match(/^---\n([\s\S]*?)\n---\n/);
      assert.ok(frontmatter, file);
      const metadata = load(frontmatter[1]) as Record<string, string>;
      assert.ok(metadata.title?.length > 0);
      assert.ok(metadata.description?.length > 0);
      assert.equal(new URL(metadata.canonical).origin, 'https://www.worldmonitor.app');
    });
  }
});
