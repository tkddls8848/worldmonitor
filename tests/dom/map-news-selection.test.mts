import { describe, expect, it, vi } from 'vitest';
import { MapContainer } from '@/components/MapContainer';
import { DeckGLMap } from '@/components/DeckGLMap';

const marker = { lat: 35, lon: 139, title: 'Same headline (approximate location: Tokyo)', threatLevel: 'info', article: { link: 'https://example.com/second', title: 'Same headline', source: 'Second publisher' } };

describe('loaded news selection callbacks', () => {
  it('dispatches the original picked Deck marker without a popup or country action', () => {
    const clicked = vi.fn();
    const map = Object.assign(Object.create(DeckGLMap.prototype), { onCountryClick: vi.fn(), popup: { show: vi.fn() } });
    map.setOnNewsClick(clicked);
    map.handleClick({ layer: { id: 'news-locations-layer' }, object: marker, x: 10, y: 10 });
    expect(clicked).toHaveBeenCalledExactlyOnceWith(marker);
    expect(map.popup.show).not.toHaveBeenCalled();
    expect(map.onCountryClick).not.toHaveBeenCalled();
  });

  it('rewires one cached callback through each active renderer after a switch', () => {
    const callback = vi.fn();
    const flat = { setOnNewsClick: vi.fn(), getState: () => ({ layers: {} }) };
    const deck = { setOnNewsClick: vi.fn(), getState: () => ({ layers: {} }) };
    const map = Object.assign(Object.create(MapContainer.prototype), { useDeckGL: false, svgMap: flat, deckGLMap: deck, emergencyLayer: { setEnabled: vi.fn() }, notamAirspaceLayer: { setEnabled: vi.fn() }, cachedNotamAirspace: [], layerLoadingState: new Map(), layerReadyState: new Map(), hiddenLayerToggles: new Set() });
    map.onNewsClicked(callback);
    expect(flat.setOnNewsClick).toHaveBeenCalledExactlyOnceWith(callback);
    map.useDeckGL = true;
    map.rehydrateActiveMap();
    expect(deck.setOnNewsClick).toHaveBeenCalledExactlyOnceWith(callback);
  });
});
