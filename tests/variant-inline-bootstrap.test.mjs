// Committed-HTML contract by design (#8690, section 2): this suite pins
// variant-host declarations in the inline pre-paint script. Runtime module
// tests do not check the committed HTML that the browser reads before those
// modules run. (The CSP hash check left with vercel.json.)
//
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const indexHtml = readFileSync(resolve(__dirname, '../index.html'), 'utf-8');
const variantBootstrapScript = indexHtml.match(/<script data-wm-prepaint>([\s\S]*?)<\/script>/)?.[1];

describe('variant inline bootstrap', () => {
  it('detects every public variant host before the app bundle loads', () => {
    for (const variant of ['happy', 'tech', 'finance', 'commodity', 'energy']) {
      assert.ok(
        indexHtml.includes(`h.startsWith('${variant}.'))v='${variant}'`),
        `index.html inline bootstrap must set data-variant for ${variant}.worldmonitor.app`,
      );
    }
  });

  it('keeps variant bootstrapping in the marked inline pre-paint script', () => {
    assert.ok(variantBootstrapScript, 'index.html must include the inline variant bootstrap script');
    assert.ok(
      variantBootstrapScript.includes('worldmonitor-variant') && variantBootstrapScript.includes('document.documentElement.dataset.variant'),
      'the marked pre-paint script must retain variant bootstrapping',
    );
  });
});
