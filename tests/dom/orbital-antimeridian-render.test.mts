import { describe, expect, it, vi } from 'vitest';

import { DeckGLMap } from '@/components/DeckGLMap';

const FIJI = { lat: -16.85, lon: 179.95, lines: ['16.8500°S 179.9500°E', 'ACQUIRED Sun, 8 Nov · 22:19 UTC · 10 M'] };

type LabelMap = { createOrbitalTargetLayer: () => Array<{ id: string; props: Record<string, unknown> }> };

function deckLabel(screenX: number, width = 860) {
  const container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', { value: width });
  const map = Object.assign(Object.create(DeckGLMap.prototype), {
    container,
    orbitalTarget: FIJI,
    maplibreMap: { project: () => ({ x: screenX, y: 300 }) },
  }) as LabelMap;
  return map.createOrbitalTargetLayer().find((layer) => layer.id === 'orbital-target-label-layer')!.props;
}

describe('orbital tag and swath at the antimeridian', () => {
  it('puts the flat-map tag left of a reticle pinned at the map edge', () => {
    expect(deckLabel(850)).toMatchObject({ getTextAnchor: 'end', getPixelOffset: [-24, 0] });
    expect(deckLabel(300)).toMatchObject({ getTextAnchor: 'start', getPixelOffset: [24, 0] });
  });

  it('fits the frame inside what the sheet and HUD leave of the map, and draws world copies past 180', () => {
    const container = document.createElement('div');
    container.getBoundingClientRect = () => new DOMRect(0, 0, 1000, 800);
    const fitBounds = vi.fn();
    const setRenderWorldCopies = vi.fn();
    const map = Object.assign(Object.create(DeckGLMap.prototype), {
      container, orbitalTarget: FIJI, orbitalTrack: null, render: vi.fn(),
      maplibreMap: { fitBounds, setRenderWorldCopies, once: vi.fn() },
    }) as DeckGLMap;
    const hud = new DOMRect(700, 0, 300, 150);
    const sheet = new DOMRect(1010, 0, 400, 800);
    map.frameOrbitalBounds([[175, -20], [185, -14]], [hud, sheet]);
    expect(fitBounds).toHaveBeenCalledWith([[175, -20], [185, -14]], expect.objectContaining({ padding: { top: 166, bottom: 40, left: 40, right: 40 } }));
    expect(setRenderWorldCopies).toHaveBeenLastCalledWith(true);
    map.setOrbitalTarget(null);
    expect(setRenderWorldCopies).toHaveBeenLastCalledWith(false);
  });
});
