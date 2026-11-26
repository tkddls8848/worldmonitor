// Regression guards for src/config/map-layer-definitions.ts:
//
//   - the `renderers: ('svg' | 'deck')[]` axis on LayerDefinition
//   - the `isLayerExecutable(key, kind)` predicate
//
// The renderers list gates whether a `layer:*` toggle (per-layer CMD+K,
// `layers:*` preset, or programmatic dispatch) is allowed to flip a layer
// on under the active renderer. Getting it wrong means toggles can set
// `mapLayers[key] = true` for layers that can't render — silent no-op state
// the user can't toggle back off if the picker hides the command under the
// current renderer.
//
// The renderer axis replaced an ambiguous `'flat'` renderer plus a
// bolted-on `deckGLOnly?: boolean` (#6773 / audit R8): `'flat'` covered both
// the SVG fallback and DeckGL, so DeckGL-only layers needed the extra flag.
// Now `'svg'` and `'deck'` are distinct, so `renderers` alone is the gate.
// The third kind, `'globe'`, went with the 3D globe renderer.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import type { MapLayers } from '../src/types';
import { persistGateOwnershipTransition } from '../src/services/variant-panel-ownership';
import {
  LAYER_REGISTRY,
  isLayerCommandAllowed,
  isLayerExecutable,
  sanitizeLayersForVariant,
  restoreGateOwnedLockedLayers,
  mapLayerStatesEqual,
} from '../src/config/map-layer-definitions';

describe('LAYER_REGISTRY — renderer axis', () => {
  test('layers with only DeckGL render paths are deck-only', () => {
    // These layers have DeckGL-only render paths. Map.ts SVG fallback has no
    // render code for them. `renderers: ['deck']`
    // is the signal that non-DeckGL contexts must not flip them on.
    assert.deepEqual(LAYER_REGISTRY.storageFacilities.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.fuelShortages.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.diseaseOutbreaks.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.liveTankers.renderers, ['deck']);
  });

  test('the CII choropleth renders on deck, not svg', () => {
    // DeckGLMap builds the CII polygons; the SVG/mobile fallback has no CII
    // paint path.
    assert.deepEqual(LAYER_REGISTRY.ciiChoropleth.renderers, ['deck']);
  });

  test('the deckGLOnly flag is fully removed from the definition shape', () => {
    // The second axis is gone; `renderers` alone gates execution now.
    assert.equal('deckGLOnly' in LAYER_REGISTRY.storageFacilities, false);
    assert.equal('deckGLOnly' in LAYER_REGISTRY.pipelines, false);
    assert.equal('deckGLOnly' in LAYER_REGISTRY.ciiChoropleth, false);
  });

  test('all-surface layers list both renderers', () => {
    // Layers with a paint path on SVG and DeckGL list both.
    assert.deepEqual(LAYER_REGISTRY.pipelines.renderers, ['svg', 'deck']);
    assert.deepEqual(LAYER_REGISTRY.conflicts.renderers, ['svg', 'deck']);
    assert.deepEqual(LAYER_REGISTRY.cables.renderers, ['svg', 'deck']);
    assert.deepEqual(LAYER_REGISTRY.sanctions.renderers, ['svg', 'deck']);
  });
});

describe('isLayerExecutable — renderer gate', () => {
  test('a deck-only layer is executable under kind "deck" but not "svg"', () => {
    // The intended ship state: DeckGL desktop can render, nothing else.
    assert.equal(isLayerExecutable('storageFacilities', 'deck'), true,
      'DeckGL should execute');
    assert.equal(isLayerExecutable('storageFacilities', 'svg'), false,
      'SVG fallback must NOT execute a deck-only layer');
  });


  test('ciiChoropleth is executable under "deck" but not "svg"', () => {
    // DeckGLMap paints the CII choropleth; the SVG fallback has no CII paint
    // path.
    assert.equal(isLayerExecutable('ciiChoropleth', 'deck'), true);
    assert.equal(isLayerExecutable('ciiChoropleth', 'svg'), false,
      'ciiChoropleth has no SVG render path');
  });

  test('an all-surface layer admits both kinds', () => {
    // `sanctions` lists svg + deck explicitly; `pipelines` takes the default.
    assert.equal(isLayerExecutable('sanctions', 'svg'), true);
    assert.equal(isLayerExecutable('sanctions', 'deck'), true);
    assert.equal(isLayerExecutable('pipelines', 'svg'), true);
    assert.equal(isLayerExecutable('pipelines', 'deck'), true);
  });

  test('unknown layer key returns false', () => {
    // Typo or stale key -> must not accidentally pass the gate.
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerExecutable('nonexistentLayer', 'deck'), false);
  });
});

describe('locked map-layer ownership', () => {
  // Regression: App.sanitizeMapLayersForTier's premium branch guarded its
  // storage write with `restored === layers`, where `restored` came out of
  // sanitizeLayersForVariant. That helper spreads its input, so the identity
  // check was ALWAYS false and the branch persisted on every pass — which is
  // how a `?layers=` deep link came to overwrite the saved (cloud-synced)
  // layer preference. Value comparison is the only correct check here.
  test('sanitizeLayersForVariant never returns its input, so identity guards are dead', () => {
    const layers = {
      conflicts: true,
    } as unknown as MapLayers;

    const out = sanitizeLayersForVariant(layers, 'full');

    assert.notEqual(
      out,
      layers,
      'a fresh object means `out === layers` can never short-circuit a write',
    );
    assert.equal(
      mapLayerStatesEqual(out, layers),
      true,
      'mapLayerStatesEqual is the comparison that actually detects "nothing changed"',
    );
  });

  test('compares layer snapshots semantically instead of by object identity', () => {
    const layers = { conflicts: true, iranAttacks: false } as unknown as MapLayers;
    assert.equal(mapLayerStatesEqual(layers, { ...layers }), true);
    assert.equal(
      mapLayerStatesEqual(layers, { ...layers, iranAttacks: true }),
      false,
    );
  });

  test('restores only valid locked layers owned by the gate', () => {
    const restored = restoreGateOwnedLockedLayers(
      {
        iranAttacks: false,
        conflicts: false,
      } as unknown as MapLayers,
      new Set(['iranAttacks', 'conflicts', 'removed-layer']),
    );

    assert.equal(restored.iranAttacks, true);
    assert.equal(restored.conflicts, false, 'ordinary user-disabled layers stay disabled');
    assert.equal('removed-layer' in restored, false, 'unknown historical keys are ignored');
  });


});

describe('isLayerCommandAllowed — CMD+K toggle policy', () => {
  test('layers that render on the active map stay toggleable', () => {
    assert.equal(isLayerCommandAllowed('no2Activity', 'deck'), true);
    assert.equal(isLayerCommandAllowed('ciiChoropleth', 'deck'), true);
  });

  test('renderer compatibility blocks commands', () => {
    // NO2 renders only on deck: the SVG fallback is blocked.
    assert.equal(isLayerCommandAllowed('no2Activity', 'svg'), false);
    // storageFacilities is deck-only: the SVG fallback cannot run it.
    assert.equal(isLayerCommandAllowed('storageFacilities', 'svg'), false);
    // ciiChoropleth renders on deck but not the SVG fallback.
    assert.equal(isLayerCommandAllowed('ciiChoropleth', 'svg'), false);
  });

  test('unknown layers never pass', () => {
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerCommandAllowed('nonexistentLayer', 'deck'), false);
  });
});

describe('isLayerExecutable — matrix of layer x kind', () => {
  // Exhaustive matrix over both renderer kinds for representative
  // layers. Future edits to the predicate that accidentally widen the
  // allowed set get caught here rather than in production.
  const cases: Array<{
    key: keyof typeof LAYER_REGISTRY;
    kind: 'svg' | 'deck';
    expect: boolean;
    why: string;
  }> = [
    // storageFacilities = ['deck'] (deck-only)
    { key: 'storageFacilities', kind: 'deck',  expect: true,  why: 'deck-only layer on deck' },
    { key: 'storageFacilities', kind: 'svg',   expect: false, why: 'deck-only layer rejects the SVG fallback' },
    // iranAttacks = ['deck'] (deck-only, locked)
    { key: 'no2Activity',    kind: 'deck',  expect: true,  why: 'NO2 on deck' },
    { key: 'no2Activity',    kind: 'svg',   expect: false, why: 'NO2 rejects SVG fallback' },
    // ciiChoropleth = ['deck']
    { key: 'ciiChoropleth',     kind: 'deck',  expect: true,  why: 'CII on deck' },
    { key: 'ciiChoropleth',     kind: 'svg',   expect: false, why: 'CII rejects the SVG fallback' },
    // sanctions = ['svg', 'deck'] (both surfaces, explicit)
    { key: 'sanctions',         kind: 'svg',   expect: true,  why: 'explicit both-surface layer on SVG' },
    { key: 'sanctions',         kind: 'deck',  expect: true,  why: 'explicit both-surface layer on deck' },
    // pipelines = ['svg', 'deck'] (default)
    { key: 'pipelines',         kind: 'svg',   expect: true,  why: 'default both-surface layer on SVG' },
    { key: 'pipelines',         kind: 'deck',  expect: true,  why: 'default both-surface layer on deck' },
  ];

  for (const c of cases) {
    test(`${c.why}`, () => {
      assert.equal(isLayerExecutable(c.key, c.kind), c.expect, c.why);
    });
  }
});
