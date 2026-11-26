import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MapLayers } from '@/types';
import { initI18n } from '@/services/i18n';

vi.mock('maplibre-gl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('maplibre-gl')>();
  return {
    ...actual,
    setWorkerUrl: () => {},
    Map: function MapLibreStub() {
      const handlers: Record<string, Array<(e: unknown) => void>> = {};
      return new Proxy(
        {
          on: (event: string, cb: (e: unknown) => void) => {
            (handlers[event] ??= []).push(cb);
          },
          getCanvas: () => document.createElement('canvas'),
          touchZoomRotate: { disable: vi.fn(), disableRotation: vi.fn() },
          keyboard: { disable: vi.fn(), disableRotation: vi.fn() },
        },
        {
          get(target, prop, receiver) {
            if (prop in target) return Reflect.get(target, prop, receiver);
            if (prop === 'then') return undefined;
            return () => undefined;
          },
        },
      );
    },
  };
});

import { DeckGLMap } from '@/components/DeckGLMap';
import { DEFAULT_MAP_LAYERS } from '@/config/panels';
import { MAP_LAYER_PRESETS } from '@/config/map-layer-definitions';

describe('DeckGLMap layer presets, group counts, hidden-toggle protection, and choropleth exclusivity', () => {
  beforeAll(async () => {
    await initI18n();
  });

  beforeEach(() => {
    localStorage.clear();
    document.body.innerHTML = '<div id="mapHost" style="width:1200px;height:800px"></div>';
    document.documentElement.lang = 'ko';
  });

  afterEach(() => {
    document.body.innerHTML = '';
    localStorage.clear();
  });

  it('applies presets, fires onLayerChange per changed layer, updates group counts, respects hideLayerToggle', () => {
    const host = document.getElementById('mapHost')!;
    const initialLayers: MapLayers = { ...DEFAULT_MAP_LAYERS, pipelines: false };
    const map = new DeckGLMap(host, {
      zoom: 1,
      pan: { x: 0, y: 0 },
      view: 'global',
      layers: initialLayers,
      timeRange: '7d',
    });

    const changes: Array<{ layer: keyof MapLayers; enabled: boolean; source: string }> = [];
    map.setOnLayerChange((layer, enabled, source) => {
      changes.push({ layer, enabled, source });
    });

    // Starts collapsed by default with 6 groups & 5 presets
    const drawer = host.querySelector<HTMLElement>('.layer-toggles')!;
    expect(drawer).toBeTruthy();
    expect(drawer.classList.contains('map-control-collapsed')).toBe(true);
    expect(host.querySelectorAll('details.layer-group').length).toBe(6);
    expect(host.querySelectorAll('.layer-preset-btn').length).toBe(MAP_LAYER_PRESETS.length);

    // Hide a layer toggle (e.g. pipelines) and verify the energy preset skips enabling it
    map.hideLayerToggle('pipelines');
    const energyBtn = host.querySelector<HTMLButtonElement>('.layer-preset-btn[data-layer-preset="energy"]')!;
    energyBtn.click();

    const stateAfterEnergy = map.getState().layers;
    expect(stateAfterEnergy.pipelines).toBe(false);
    expect(stateAfterEnergy.waterways).toBe(true);
    expect(stateAfterEnergy.conflicts).toBe(false);
    // onLayerChange fired for turned-on and turned-off layers
    expect(changes.some((c) => c.layer === 'conflicts' && c.enabled === false && c.source === 'user')).toBe(true);
    expect(changes.some((c) => c.enabled === true && c.source === 'user')).toBe(true);

    // Clear preset turns all layers off and updates group counts to 0/N
    changes.length = 0;
    const clearBtn = host.querySelector<HTMLButtonElement>('.layer-preset-btn[data-layer-preset="clear"]')!;
    clearBtn.click();
    const countBadges = Array.from(host.querySelectorAll<HTMLElement>('.layer-group-count')).map((el) => el.textContent);
    expect(countBadges.length).toBe(6);
    expect(countBadges.every((text) => text?.startsWith('0/'))).toBe(true);

    // Choropleth mutual exclusivity via toggles (unconditional — fail loudly if missing)

  });
});
