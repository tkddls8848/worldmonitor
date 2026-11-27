import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { MapLayers } from '../src/types/index.ts';
import { DEFAULT_MAP_LAYERS } from '../src/config/panels.ts';
import {
  LAYER_REGISTRY,
  restoreGateOwnedLockedLayers,
  sanitizeLayersForVariant,
  type MapVariant,
} from '../src/config/map-layer-definitions.ts';
import { parseMapUrlState } from '../src/utils/urlState.ts';
import { filterMissionLayersForRenderer } from '../src/services/mission-presets.ts';

// Map layers removed at the owner's request. Saved state written before the
// removal (localStorage layer blobs, ?layers= deep links, restored settings
// backups, gate-ownership markers) still names them and must load cleanly.
const REMOVED_LAYERS = [
  'radiationWatch',
  'spaceports',
  'satellites',
  'dayNight',
  'canadaRoads',
  'canadaAlerts',
  'irradiators',
] as const;

const VARIANTS: MapVariant[] = ['full', 'tech', 'finance',  'commodity', 'energy'];

function staleSavedBlob(): MapLayers {
  const blob: Record<string, boolean> = { ...DEFAULT_MAP_LAYERS, conflicts: true };
  for (const key of REMOVED_LAYERS) blob[key] = true;
  return blob as unknown as MapLayers;
}

describe('removed map layers in saved state', () => {
  it('are no longer map layers anywhere in the registry or defaults', () => {
    for (const key of REMOVED_LAYERS) {
      assert.equal(Object.prototype.hasOwnProperty.call(LAYER_REGISTRY, key), false, `${key} is still registered`);
      assert.equal(Object.prototype.hasOwnProperty.call(DEFAULT_MAP_LAYERS, key), false, `${key} still has a default`);
    }
  });

  it('a stored layer blob that enables them is sanitized without error for every variant', () => {
    for (const variant of VARIANTS) {
      const sanitized = sanitizeLayersForVariant(staleSavedBlob(), variant);
      for (const key of REMOVED_LAYERS) {
        assert.equal(key in sanitized, false, `${variant}: ${key} survived sanitize`);
      }
      for (const key of Object.keys(sanitized)) {
        assert.ok(key in LAYER_REGISTRY, `${variant}: unknown key ${key} survived sanitize`);
      }
    }
    const full = sanitizeLayersForVariant(staleSavedBlob(), 'full');
    assert.equal(full.conflicts, true, 'a still-valid saved choice is kept');
  });

  it('a ?layers= deep link naming them keeps the valid layers and ignores the rest', () => {
    const parsed = parseMapUrlState(
      '?layers=conflicts,dayNight,satellites,satelliteImagery,canadaRoads,canadaAlerts,radiationWatch,spaceports,irradiators',
      staleSavedBlob(),
    );
    assert.ok(parsed.layers);
    const sanitized = sanitizeLayersForVariant(parsed.layers!, 'full');
    assert.equal(sanitized.conflicts, true);
    for (const key of REMOVED_LAYERS) {
      assert.equal(key in sanitized, false, `${key} survived the deep link`);
    }
    assert.equal('satelliteImagery' in sanitized, false);
  });

  it('renderer filtering and gate-ownership restore tolerate stale keys', () => {
    const stale = staleSavedBlob();
    assert.doesNotThrow(() => filterMissionLayersForRenderer(stale, 'deck'));
    assert.doesNotThrow(() => filterMissionLayersForRenderer(stale, 'svg'));
    const layers = sanitizeLayersForVariant(stale, 'full');
    const restored = restoreGateOwnedLockedLayers(layers, new Set(['dayNight', 'satellites']));
    assert.equal(restored, layers, 'a stale ownership marker changes nothing');
  });
});
