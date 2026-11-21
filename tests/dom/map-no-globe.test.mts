/**
 * The 3D globe renderer and the 2D/3D switch are gone (owner decision,
 * docs/superpowers/specs/2026-11-21-frontend-performance-design.md §5.1).
 *
 * - RF1: a browser that saved the old `globe` preference opens the DeckGL
 *   flat map on a desktop WebGL2 client, with no error and no blank map.
 * - RF2: the same preference on a phone-width or no-WebGL client opens SVG.
 * - RF3: an agent asking for the globe gets the `globe_unavailable` denial;
 *   the map is not silently switched.
 * - RF4: every layer keeps a flat renderer, and no layer names the globe.
 * - The WebMCP layer catalog no longer offers a `3d` renderer filter.
 * - Enabling `satellites` on the flat map loads only imagery footprints; the
 *   live-position propagation that fed the globe is not started.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import mapContainerSource from '@/components/MapContainer.ts?raw';
import panelLayoutSource from '@/app/panel-layout.ts?raw';
import dataLoaderSource from '@/app/data-loader.ts?raw';
import { LAYER_REGISTRY } from '@/config/map-layer-definitions';
import {
  WEBMCP_MAP_LAYER_RENDERERS,
  parseMapLayerCatalogArgs,
  rendererFamily,
} from '@/services/webmcp-map-layer-catalog';
import { applyAgentBusAction } from '@/app/agent-bus-applier';
import type { AppContext } from '@/app/app-context';
import type { MapLayers } from '@/types';

// The key the removed 2D/3D control wrote (`STORAGE_KEYS.mapMode`).
const LEGACY_MAP_MODE_KEY = 'worldmonitor-map-mode';

const renderers = vi.hoisted(() => ({ deck: 0, svg: 0 }));

/** A constructible renderer stand-in: `new Stub(container, state)` counts the mount. */
function rendererStub(kind: 'deck' | 'svg') {
  return function RendererStub(_container: HTMLElement, state: unknown): object {
    renderers[kind] += 1;
    const base = {
      getState: (): unknown => state,
      whenReady: (): Promise<void> => Promise.resolve(),
      whenViewportSettled: (): Promise<boolean> => Promise.resolve(true),
      destroy: (): void => {},
    };
    // Every other renderer method is a no-op so rehydration cannot throw.
    return new Proxy(base, {
      get(target, prop, receiver) {
        if (prop in target) return Reflect.get(target, prop, receiver);
        if (prop === 'then') return undefined;
        return () => undefined;
      },
    });
  };
}

interface MapStub {
  handlers: Record<string, Array<(event: unknown) => void>>;
  touchZoomRotate: { disable: () => void; disableRotation: () => void };
  keyboard: { disable: () => void; disableRotation: () => void };
}

const mapOptions = vi.hoisted(() => [] as Array<Record<string, unknown>>);
const mapStubs = vi.hoisted(() => [] as MapStub[]);
// With `error` set the MapLibre stand-in throws right after it captures the
// options; with null it builds a stub map so construction runs to the end.
const mapLibreFatal = vi.hoisted(() => ({
  error: new Error('stop after the options are captured') as Error | null,
}));

vi.mock('maplibre-gl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('maplibre-gl')>();
  return {
    ...actual,
    setWorkerUrl: () => {},
    Map: class {
      constructor(options: Record<string, unknown>) {
        mapOptions.push(options);
        if (mapLibreFatal.error) throw mapLibreFatal.error;
        const handlers: MapStub['handlers'] = {};
        const stub = {
          handlers,
          touchZoomRotate: { disable: vi.fn(), disableRotation: vi.fn() },
          keyboard: { disable: vi.fn(), disableRotation: vi.fn() },
          on: (event: string, handler: (event: unknown) => void) => {
            (handlers[event] ??= []).push(handler);
          },
          getCanvas: () => document.createElement('canvas'),
        };
        mapStubs.push(stub);
        // Every other map method is a no-op.
        return new Proxy(stub, {
          get(target, prop, receiver) {
            if (prop in target) return Reflect.get(target, prop, receiver);
            if (prop === 'then') return undefined;
            return () => undefined;
          },
        });
      }
    },
  };
});

vi.mock('@/components/DeckGLMap', () => ({ DeckGLMap: rendererStub('deck') }));
vi.mock('@/components/Map', () => ({ MapComponent: rendererStub('svg') }));

const { MapContainer } = await import('@/components/MapContainer');

const INITIAL_LAYERS = { satellites: false, resilienceScore: false } as unknown as MapLayers;

function stubWebGL(kind: 'webgl2' | 'none'): void {
  const original = HTMLCanvasElement.prototype.getContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, id: string, ...rest: unknown[]) {
    if (id === 'webgl2' && kind === 'webgl2') {
      return {
        getExtension: () => null,
        getParameter: () => '',
      } as unknown as RenderingContext;
    }
    if (id === 'webgl2' || id === 'webgl' || id === 'experimental-webgl') return null;
    return (original as (...args: unknown[]) => RenderingContext | null).call(this, id, ...rest);
  } as typeof HTMLCanvasElement.prototype.getContext);
}

function setViewportWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

/** Mounts the map the way `panel-layout.ts` does. */
async function mountMap(): Promise<{ map: InstanceType<typeof MapContainer>; container: HTMLElement }> {
  const container = document.createElement('div');
  container.id = 'mapContainer';
  document.body.append(container);
  const map = new MapContainer(container, {
    zoom: 1,
    pan: { x: 0, y: 0 },
    view: 'global',
    layers: INITIAL_LAYERS,
    timeRange: '7d',
  });
  await map.whenRendererReady();
  return { map, container };
}

describe('map without the 3D globe', () => {
  let errors: unknown[];

  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    localStorage.setItem(LEGACY_MAP_MODE_KEY, JSON.stringify('globe'));
    renderers.deck = 0;
    renderers.svg = 0;
    errors = [];
    vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args); });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    setViewportWidth(1440);
  });

  it('RF1: a saved globe preference opens the DeckGL flat map on a desktop WebGL2 client', async () => {
    setViewportWidth(1440);
    stubWebGL('webgl2');

    const { map, container } = await mountMap();

    expect(map.isDeckGLActive()).toBe(true);
    expect(renderers).toEqual({ deck: 1, svg: 0 });
    expect(container.classList.contains('deckgl-mode')).toBe(true);
    expect(container.classList.contains('globe-mode')).toBe(false);
    expect(container.dataset.mapRendererPending).toBeUndefined();
    expect(errors).toEqual([]);
    // The renderer choice no longer reads the stored preference at all.
    expect(panelLayoutSource).not.toMatch(/getStoredMapModePreference|preferGlobe|mapDimensionToggle/);
    expect(mapContainerSource).not.toMatch(/preferGlobe|isGlobeMode|globeMap|switchToGlobe/);
  });

  it('RF2: the same preference opens the SVG map at phone width', async () => {
    setViewportWidth(390);
    stubWebGL('webgl2');

    const { map, container } = await mountMap();

    expect(map.isDeckGLActive()).toBe(false);
    expect(renderers).toEqual({ deck: 0, svg: 1 });
    expect(container.classList.contains('svg-mode')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('RF2: the same preference opens the SVG map without WebGL', async () => {
    setViewportWidth(1440);
    stubWebGL('none');

    const { map, container } = await mountMap();

    expect(map.isDeckGLActive()).toBe(false);
    expect(renderers).toEqual({ deck: 0, svg: 1 });
    expect(container.classList.contains('svg-mode')).toBe(true);
    expect(errors).toEqual([]);
  });

  it('RF3: an agent request for 3d is denied with globe_unavailable and the map stays flat', async () => {
    const setLayers = vi.fn();
    const ctx = {
      mapLayers: { resilienceScore: true } as unknown as MapLayers,
      map: {
        isDeckGLActive: () => true,
        setLayers,
      },
    } as unknown as AppContext;

    const result = await applyAgentBusAction(ctx, { type: 'set_map_mode', mode: '3d' });

    expect(result).toMatchObject({
      ok: false,
      status: 'denied',
      reason: 'globe_unavailable',
      actionType: 'set_map_mode',
      targets: [{ target: '3d', status: 'denied', reason: 'globe_unavailable' }],
      requested: { mode: '3d' },
      effective: { mode: '2d', renderer: 'deck' },
    });
    expect(setLayers).not.toHaveBeenCalled();
    expect(ctx.mapLayers.resilienceScore).toBe(true);
    expect(localStorage.getItem(LEGACY_MAP_MODE_KEY)).toBe(JSON.stringify('globe'));

    const flat = await applyAgentBusAction(ctx, { type: 'set_map_mode', mode: '2d' });
    expect(flat).toMatchObject({
      ok: true,
      status: 'applied',
      effective: { mode: '2d', renderer: 'deck' },
    });
  });

  it('RF4: every layer keeps a flat renderer and none names the globe', () => {
    for (const [key, def] of Object.entries(LAYER_REGISTRY)) {
      const kinds = def.renderers as readonly string[];
      expect(kinds.includes('deck') || kinds.includes('svg'), `${key} must stay reachable on a flat renderer`).toBe(true);
      expect(kinds, `${key} must not list the removed globe renderer`).not.toContain('globe');
    }
  });

  it('the WebMCP layer catalog offers no 3d renderer filter', () => {
    expect([...WEBMCP_MAP_LAYER_RENDERERS]).toEqual(['2d']);
    expect(rendererFamily()).toBe('2d');
    expect(parseMapLayerCatalogArgs({ renderer: '3d' })).toMatchObject({
      ok: false,
      reason: 'invalid_renderer',
    });
    expect(parseMapLayerCatalogArgs({ renderer: '2d' }).ok).toBe(true);
  });

  it('enabling satellites on the flat map loads imagery footprints, not live satellite positions', async () => {
    const requested: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input instanceof Request ? input.url : input));
      return new Response(JSON.stringify({ scenes: [] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }));

    const { DataLoaderManager } = await import('@/app/data-loader');
    const setSatellites = vi.fn();
    const setImageryScenes = vi.fn();
    const ctx = {
      isDestroyed: false,
      inFlight: new Set<string>(),
      mapLayers: { satellites: true } as unknown as MapLayers,
      map: {
        setLayerLoading: vi.fn(),
        getBbox: () => '-10,-10,10,10',
        setImageryScenes,
        setSatellites,
        isDeckGLActive: () => true,
      },
      panels: {},
      intelligenceCache: {},
    } as unknown as AppContext;
    const loader = new DataLoaderManager(ctx, {
      renderCriticalBanner: () => {},
      refreshOpenCountryBrief: () => {},
    });

    await loader.loadDataForLayer('satellites');
    await vi.waitFor(() => expect(setImageryScenes).toHaveBeenCalledWith([]));

    expect(requested.some((url) => url.includes('/api/imagery/v1/search-imagery'))).toBe(true);
    expect(requested.filter((url) => url.includes('list-satellites'))).toEqual([]);
    expect(setSatellites).not.toHaveBeenCalled();
    expect('loadSatellites' in DataLoaderManager.prototype).toBe(false);
    expect(dataLoaderSource).not.toMatch(/startPropagationLoop|propagatePositions|fetchSatelliteTLEs/);
    loader.stopLayerActivity('satellites');
  });
});

describe('flat map interaction', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['3d', 'flat', ''])('locks pitch and rotation whatever VITE_MAP_INTERACTION_MODE is (%j)', async (mode) => {
    vi.stubEnv('VITE_MAP_INTERACTION_MODE', mode);
    const { DeckGLMap } = await vi.importActual<typeof import('@/components/DeckGLMap')>('@/components/DeckGLMap');
    const basemap = document.createElement('div');
    basemap.id = 'deckgl-basemap';
    document.body.append(basemap);
    const fatal = mapLibreFatal.error;
    mapOptions.length = 0;
    const self = {
      destroyed: false,
      mapLibreWorkerUrl: '',
      state: { view: 'global', zoom: 2 },
      container: document.createElement('div'),
      resolveInitialBasemapStyle: async () => ({ mapTheme: 'dark', style: 'https://example.test/style.json' }),
    };
    await expect(
      (DeckGLMap.prototype as unknown as { initMapLibre(this: unknown): Promise<void> }).initMapLibre.call(self),
    ).rejects.toBe(fatal);
    basemap.remove();
    expect(mapOptions).toHaveLength(1);
    expect(mapOptions[0]).toMatchObject({ maxPitch: 0, dragRotate: false, pitchWithRotate: false });
  });

  it('stops twist and keyboard rotation on the primary and the fallback map, keeping pinch zoom', async () => {
    const { DeckGLMap } = await vi.importActual<typeof import('@/components/DeckGLMap')>('@/components/DeckGLMap');
    const basemap = document.createElement('div');
    basemap.id = 'deckgl-basemap';
    document.body.append(basemap);
    const fatal = mapLibreFatal.error;
    mapLibreFatal.error = null;
    mapOptions.length = 0;
    mapStubs.length = 0;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const self = {
      destroyed: false,
      usedFallbackStyle: false,
      webglLost: false,
      styleLoadTimeoutId: null as ReturnType<typeof setTimeout> | null,
      mapLibreWorkerUrl: '',
      state: { view: 'global', zoom: 2 },
      container: document.createElement('div'),
      // A pmtiles style keeps the primary basemap, so a fetch failure can fall back.
      resolveInitialBasemapStyle: async () => ({ mapTheme: 'dark', style: 'pmtiles://example.test/style.json' }),
      getCenter: () => null,
      attachMapLibreInteractionHandlers: () => {},
      detachMapLibreInteractionHandlers: () => {},
    };
    try {
      await (DeckGLMap.prototype as unknown as { initMapLibre(this: unknown): Promise<void> }).initMapLibre.call(self);
      expect(mapStubs).toHaveLength(1);
      // Two network errors before any tile loaded rebuild the map on the fallback style.
      const onError = mapStubs[0]!.handlers.error?.[0];
      expect(onError).toBeTypeOf('function');
      onError!({ error: { message: 'Failed to fetch' } });
      onError!({ error: { message: 'Failed to fetch' } });
      expect(mapStubs).toHaveLength(2);
    } finally {
      if (self.styleLoadTimeoutId) clearTimeout(self.styleLoadTimeoutId);
      basemap.remove();
      mapLibreFatal.error = fatal;
      vi.restoreAllMocks();
    }
    for (const [index, map] of mapStubs.entries()) {
      const which = index === 0 ? 'primary' : 'fallback';
      expect(map.touchZoomRotate.disableRotation, which).toHaveBeenCalledTimes(1);
      expect(map.keyboard.disableRotation, which).toHaveBeenCalledTimes(1);
      // Pinch zoom and arrow-key panning stay on.
      expect(map.touchZoomRotate.disable, which).not.toHaveBeenCalled();
      expect(map.keyboard.disable, which).not.toHaveBeenCalled();
    }
    for (const options of mapOptions) {
      expect(options).toMatchObject({ maxPitch: 0, dragRotate: false, pitchWithRotate: false });
      expect(options.touchZoomRotate).not.toBe(false);
      expect(options.keyboard).not.toBe(false);
    }
  });
});
