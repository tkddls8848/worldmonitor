// Regression guards for src/config/map-layer-definitions.ts:
//
//   - the `renderers: ('svg' | 'deck' | 'globe')[]` axis on LayerDefinition
//   - the `isLayerExecutable(key, kind)` predicate
//
// The renderers list gates whether a `layer:*` toggle (per-layer CMD+K,
// `layers:*` preset, or programmatic dispatch) is allowed to flip a layer
// on under the active renderer. Getting it wrong means toggles can set
// `mapLayers[key] = true` for layers that can't render — silent no-op state
// the user can't toggle back off if the picker hides the command under the
// current renderer.
//
// The single 3-kind axis replaced an ambiguous `'flat'` renderer plus a
// bolted-on `deckGLOnly?: boolean` (#6773 / audit R8): `'flat'` covered both
// the SVG fallback and DeckGL, so DeckGL-only layers needed the extra flag.
// Now `'svg'` and `'deck'` are distinct, so `renderers` alone is the gate.

import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import type { MapLayers } from '../src/types';
import { persistGateOwnershipTransition } from '../src/services/variant-panel-ownership';
import {
  LAYER_REGISTRY,
  LAYER_SYNONYMS,
  isLayerCommandAllowed,
  isLayerExecutable,
  sanitizeLayersForVariant,
  restoreGateOwnedLockedLayers,
  mapLayerStatesEqual,
} from '../src/config/map-layer-definitions';

describe('LAYER_REGISTRY — renderer axis', () => {
  test('layers with only DeckGL render paths are deck-only', () => {
    // These layers have DeckGL-only render paths. GlobeMap has no branch for
    // them, and Map.ts SVG fallback has no render code. `renderers: ['deck']`
    // is the signal that non-DeckGL contexts must not flip them on.
    assert.deepEqual(LAYER_REGISTRY.storageFacilities.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.fuelShortages.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.diseaseOutbreaks.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.resilienceScore.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.canadaRoads.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.canadaAlerts.renderers, ['deck']);
    assert.deepEqual(LAYER_REGISTRY.liveTankers.renderers, ['deck']);
  });

  test('the CII choropleth renders on deck + globe, not svg', () => {
    // #6773 / R8 bug fix: GlobeMap AND DeckGLMap both build CII polygons, but
    // the SVG/mobile fallback has no CII paint path. The old `['flat']` value
    // wrongly excluded it from the globe picker.
    assert.deepEqual(LAYER_REGISTRY.ciiChoropleth.renderers, ['deck', 'globe']);
  });

  test('the deckGLOnly flag is fully removed from the definition shape', () => {
    // The second axis is gone; `renderers` alone gates execution now.
    assert.equal('deckGLOnly' in LAYER_REGISTRY.storageFacilities, false);
    assert.equal('deckGLOnly' in LAYER_REGISTRY.pipelines, false);
    assert.equal('deckGLOnly' in LAYER_REGISTRY.ciiChoropleth, false);
  });

  test('Toronto restrictions reuse canadaRoads and do not add a second layer id', () => {
    assert.equal('torontoRoads' in LAYER_REGISTRY, false);
    assert.ok(LAYER_REGISTRY.canadaRoads);
    assert.equal(LAYER_REGISTRY.canadaRoads.key, 'canadaRoads');
    assert.deepEqual(LAYER_SYNONYMS.toronto, ['canadaRoads']);
  });

  test('all-surface layers list every renderer', () => {
    // Layers with a paint path on SVG, DeckGL, and the globe list all three.
    assert.deepEqual(LAYER_REGISTRY.pipelines.renderers, ['svg', 'deck', 'globe']);
    assert.deepEqual(LAYER_REGISTRY.conflicts.renderers, ['svg', 'deck', 'globe']);
    assert.deepEqual(LAYER_REGISTRY.cables.renderers, ['svg', 'deck', 'globe']);
    // Flat-surface-only layers (no globe paint path) are svg + deck.
    assert.deepEqual(LAYER_REGISTRY.sanctions.renderers, ['svg', 'deck']);
    assert.deepEqual(LAYER_REGISTRY.dayNight.renderers, ['svg', 'deck']);
  });
});

describe('isLayerExecutable — renderer gate', () => {
  test('a deck-only layer is executable under kind "deck" but not "svg" or "globe"', () => {
    // The intended ship state: DeckGL desktop can render, nothing else.
    assert.equal(isLayerExecutable('storageFacilities', 'deck'), true,
      'DeckGL should execute');
    assert.equal(isLayerExecutable('storageFacilities', 'svg'), false,
      'SVG fallback must NOT execute a deck-only layer');
    assert.equal(isLayerExecutable('storageFacilities', 'globe'), false,
      'globe mode must NOT execute (no GlobeMap render path)');
  });

  test('resilienceScore is executable only under kind "deck"', () => {
    assert.equal(isLayerExecutable('resilienceScore', 'deck'), true,
      'DeckGL should execute resilienceScore');
    assert.equal(isLayerExecutable('resilienceScore', 'svg'), false,
      'SVG fallback must NOT execute resilienceScore');
    assert.equal(isLayerExecutable('resilienceScore', 'globe'), false,
      'globe mode must NOT execute resilienceScore');
  });

  test('ciiChoropleth is executable under "globe" and "deck" but not "svg"', () => {
    // #6773 / R8 bug-fix pin: both DeckGLMap and GlobeMap paint the CII
    // choropleth, but the SVG fallback has no CII paint path. This is the
    // assertion that would have caught the layer being wrongly excluded
    // from the globe layer picker.
    assert.equal(isLayerExecutable('ciiChoropleth', 'deck'), true);
    assert.equal(isLayerExecutable('ciiChoropleth', 'globe'), true);
    assert.equal(isLayerExecutable('ciiChoropleth', 'svg'), false,
      'ciiChoropleth has no SVG render path');
  });

  test('a flat-surface layer admits svg + deck but not globe', () => {
    // `sanctions`/`dayNight` render on the SVG fallback and DeckGL, but
    // have no globe paint path.
    assert.equal(isLayerExecutable('sanctions', 'svg'), true);
    assert.equal(isLayerExecutable('sanctions', 'deck'), true);
    assert.equal(isLayerExecutable('sanctions', 'globe'), false,
      'sanctions has no globe renderer');
  });

  test('all-surface layer admits every kind', () => {
    // `pipelines` has renderers:['svg', 'deck', 'globe'] (default).
    assert.equal(isLayerExecutable('pipelines', 'svg'), true);
    assert.equal(isLayerExecutable('pipelines', 'deck'), true);
    assert.equal(isLayerExecutable('pipelines', 'globe'), true);
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
      resilienceScore: false,
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
    const layers = { conflicts: true, resilienceScore: false } as unknown as MapLayers;
    assert.equal(mapLayerStatesEqual(layers, { ...layers }), true);
    assert.equal(
      mapLayerStatesEqual(layers, { ...layers, resilienceScore: true }),
      false,
    );
  });

  test('restores only valid locked layers owned by the gate', () => {
    const restored = restoreGateOwnedLockedLayers(
      {
        resilienceScore: false,
        conflicts: false,
      } as unknown as MapLayers,
      new Set(['resilienceScore', 'conflicts', 'removed-layer']),
    );

    assert.equal(restored.resilienceScore, true);
    assert.equal(restored.conflicts, false, 'ordinary user-disabled layers stay disabled');
    assert.equal('removed-layer' in restored, false, 'unknown historical keys are ignored');
  });

  test('does not let stale resilience ownership override an enabled CII choropleth', () => {
    const restored = restoreGateOwnedLockedLayers(
      {
        resilienceScore: false,
        ciiChoropleth: true,
      } as unknown as MapLayers,
      new Set(['resilienceScore']),
    );

    assert.equal(restored.resilienceScore, false);
    assert.equal(restored.ciiChoropleth, true);
  });

});

describe('isLayerCommandAllowed — CMD+K toggle policy', () => {
  test('layers that render on the active map stay toggleable', () => {
    assert.equal(isLayerCommandAllowed('resilienceScore', 'deck'), true);
    assert.equal(isLayerCommandAllowed('ciiChoropleth', 'deck'), true);
  });

  test('renderer compatibility blocks commands', () => {
    // resilience renders only on deck: globe is blocked.
    assert.equal(isLayerCommandAllowed('resilienceScore', 'globe'), false);
    // storageFacilities is deck-only: the SVG fallback cannot run it.
    assert.equal(isLayerCommandAllowed('storageFacilities', 'svg'), false);
    // ciiChoropleth renders on deck/globe but not the SVG fallback.
    assert.equal(isLayerCommandAllowed('ciiChoropleth', 'svg'), false);
  });

  test('unknown layers never pass', () => {
    // @ts-expect-error — intentionally passing a key outside the union
    assert.equal(isLayerCommandAllowed('nonexistentLayer', 'deck'), false);
  });
});

describe('isLayerExecutable — matrix of layer x kind', () => {
  // Exhaustive matrix over the three renderer kinds for representative
  // layers. Future edits to the predicate that accidentally widen the
  // allowed set get caught here rather than in production.
  const cases: Array<{
    key: keyof typeof LAYER_REGISTRY;
    kind: 'svg' | 'deck' | 'globe';
    expect: boolean;
    why: string;
  }> = [
    // storageFacilities = ['deck'] (deck-only)
    { key: 'storageFacilities', kind: 'deck',  expect: true,  why: 'deck-only layer on deck' },
    { key: 'storageFacilities', kind: 'svg',   expect: false, why: 'deck-only layer rejects the SVG fallback' },
    { key: 'storageFacilities', kind: 'globe', expect: false, why: 'deck-only layer rejects globe' },
    // resilienceScore = ['deck'] (deck-only, locked)
    { key: 'resilienceScore',   kind: 'deck',  expect: true,  why: 'resilience on deck' },
    { key: 'resilienceScore',   kind: 'svg',   expect: false, why: 'resilience rejects SVG fallback' },
    { key: 'resilienceScore',   kind: 'globe', expect: false, why: 'resilience rejects globe' },
    // ciiChoropleth = ['deck', 'globe']
    { key: 'ciiChoropleth',     kind: 'deck',  expect: true,  why: 'CII on deck' },
    { key: 'ciiChoropleth',     kind: 'globe', expect: true,  why: 'CII on globe (the bug fix)' },
    { key: 'ciiChoropleth',     kind: 'svg',   expect: false, why: 'CII rejects the SVG fallback' },
    // sanctions = ['svg', 'deck'] (flat-surface, no globe)
    { key: 'sanctions',         kind: 'svg',   expect: true,  why: 'flat-surface layer on SVG' },
    { key: 'sanctions',         kind: 'deck',  expect: true,  why: 'flat-surface layer on deck' },
    { key: 'sanctions',         kind: 'globe', expect: false, why: 'flat-surface layer rejects globe' },
    // pipelines = ['svg', 'deck', 'globe'] (all surfaces)
    { key: 'pipelines',         kind: 'svg',   expect: true,  why: 'all-surface layer on SVG' },
    { key: 'pipelines',         kind: 'deck',  expect: true,  why: 'all-surface layer on deck' },
    { key: 'pipelines',         kind: 'globe', expect: true,  why: 'all-surface layer on globe' },
  ];

  for (const c of cases) {
    test(`${c.why}`, () => {
      assert.equal(isLayerExecutable(c.key, c.kind), c.expect, c.why);
    });
  }
});
