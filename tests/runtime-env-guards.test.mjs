// Env-source guard by design (#8690, section 2): this suite checks explicit
// Vite env reads and rejects whole-object and dynamic-access source patterns.
// Runtime values after Vite replaces env expressions cannot show which
// source-access pattern produced them.
//
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const runtimeSrc = readFileSync(resolve(__dirname, '../src/services/runtime.ts'), 'utf-8');
const variantSrc = readFileSync(resolve(__dirname, '../src/config/variant.ts'), 'utf-8');

describe('runtime env guards', () => {
  it('reads only explicit import.meta.env properties through a guarded ENV wrapper', () => {
    assert.doesNotMatch(
      runtimeSrc,
      /return\s+import\.meta\.env\b/,
      'runtime.ts must not return the whole Vite env object to client code',
    );
    assert.doesNotMatch(
      runtimeSrc,
      /\b(?:const|let|var)\s+\w+\s*=\s*import\.meta\.env\b/,
      'runtime.ts must not snapshot import.meta.env into a local object',
    );
    for (const key of [
      'VITE_WS_API_URL',
    ]) {
      assert.ok(
        runtimeSrc.includes(`${key}: import.meta.env.${key}`),
        `runtime ENV wrapper must explicitly allow ${key}`,
      );
    }
  });

  it('runtime-config.ts does not dynamically read the Vite env object for secrets', () => {
    const runtimeConfigSrc = readFileSync(resolve(__dirname, '../src/services/runtime-config.ts'), 'utf-8');
    assert.doesNotMatch(
      runtimeConfigSrc,
      /\.env\?\.\[[^\]]+\]/,
      'runtime-config.ts must not dynamically index import.meta.env for runtime secrets',
    );
  });

  it('reuses the guarded ENV wrapper for runtime env lookups', () => {
    assert.ok(runtimeSrc.includes('const WS_API_URL = ENV.VITE_WS_API_URL || \'\''), 'WS API URL should read from ENV');
  });
});

describe('variant env guards', () => {
  it('computes the build variant through a guarded import.meta.env access', () => {
    assert.match(
      variantSrc,
      /const buildVariant = \(\(\) => \{\s*try \{\s*return import\.meta\.env\.VITE_VARIANT \|\| 'full';\s*\} catch \{\s*return 'full';\s*\}\s*\}\)\(\);/s,
    );
  });

  it('reuses buildVariant for SSR, missing-location, and localhost fallback paths', () => {
    const buildVariantUses = variantSrc.match(/return buildVariant;/g) ?? [];
    assert.equal(buildVariantUses.length, 3, `Expected three buildVariant fallbacks, got ${buildVariantUses.length}`);
    assert.ok(variantSrc.includes("if (typeof window === 'undefined') return buildVariant;"), 'SSR should fall back to buildVariant');
  });
});
