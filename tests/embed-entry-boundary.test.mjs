// These source checks pin embed-specific imports, request wiring, and credential
// boundaries beyond the layer linter's rules (#8690, section 2).
// A mounted embed exercises selected paths, not every forbidden source reference.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

describe('embed entry boundary', () => {
  it('keeps the shared SVG map independent of runtime/auth imports used by the app shell', () => {
    const source = readFileSync(resolve(root, 'src/components/Map.ts'), 'utf-8');
    assert.ok(!source.includes("@/services/runtime"), 'Map.ts must not import services/runtime because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/auth-state"), 'Map.ts must not import auth-state because the public embed imports Map.ts');
    assert.ok(!source.includes("@/services/clerk"), 'Map.ts must not import Clerk because the public embed imports Map.ts');
  });
});
