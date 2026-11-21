import { expect, test } from '@playwright/test';

test.describe('runtime loading guardrails', () => {

  test('chunk preload reload guard reloads once per build', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const {
        CHUNK_RELOAD_STORAGE_KEY,
        installChunkReloadGuard,
      } = await import('/src/bootstrap/chunk-reload.ts');

      const storageMap = new Map<string, string>();
      const storage = {
        getItem: (key: string) => storageMap.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storageMap.set(key, value);
        },
      };
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

      let reloadCount = 0;
      // Each install models a page load that shares the surviving storage.
      const pageLoad = async (version: string) => {
        const eventTarget = new EventTarget();
        installChunkReloadGuard(version, {
          eventTarget,
          storages: [storage],
          eventName: 'preload-error',
          reload: () => {
            reloadCount += 1;
          },
        });
        eventTarget.dispatchEvent(new Event('preload-error', { cancelable: true }));
        eventTarget.dispatchEvent(new Event('preload-error', { cancelable: true }));
        await settle();
      };

      await pageLoad('9.9.9');
      await pageLoad('9.9.9');
      const reloadCountSameBuild = reloadCount;
      await pageLoad('9.9.10');

      return {
        reloadCountSameBuild,
        reloadCountAfterNewBuild: reloadCount,
        storedValue: storageMap.get(CHUNK_RELOAD_STORAGE_KEY) ?? null,
      };
    });

    expect(result.reloadCountSameBuild).toBe(1);
    expect(result.reloadCountAfterNewBuild).toBe(2);
    expect(result.storedValue).toBe('9.9.10');
  });

  test('MapContainer paints a mobile shell before heavy map renderer resources', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();

      const isHeavyMapResource = (name: string): boolean =>
        /DeckGLMap|maplibre|deck-stack|pmtiles|\.pmtiles|@deck\.gl|@luma\.gl|@loaders\.gl/i.test(name);
      const heavyResourceNames = (): string[] =>
        performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter(isHeavyMapResource);
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!(
          host.classList.contains('svg-mode')
          || host.classList.contains('deckgl-mode')
        )) {
          if (performance.now() > deadline) throw new Error('Map renderer did not settle');
          await nextFrame();
        }
      };

      performance.clearResourceTimings();
      const { MapContainer } = await import('/src/components/MapContainer.ts');
      const heavyAfterMapContainerImport = heavyResourceNames();

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      let webglProbeCalls = 0;
      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          if (contextId.toLowerCase().includes('webgl')) webglProbeCalls += 1;
          return Reflect.apply(originalGetContext, this, [contextId, options]);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        const webglProbeCallsAtShell = webglProbeCalls;

        const shellRect = mapHost.getBoundingClientRect();
        const shellState = {
          hasShellClass: mapHost.classList.contains('map-renderer-shell'),
          ariaBusy: mapHost.getAttribute('aria-busy'),
          pendingRenderer: mapHost.dataset.mapRendererPending ?? null,
          shellChildCount: mapHost.querySelectorAll('.map-renderer-shell-surface').length,
          width: shellRect.width,
          height: shellRect.height,
        };

        await nextFrame();
        const heavyBeforeShellPaint = heavyResourceNames();
        await waitForRenderer(mapHost);
        const settledRect = mapHost.getBoundingClientRect();
        const heavyAfterMobileFallback = heavyResourceNames();

        return {
          shellState,
          heavyAfterMapContainerImport,
          heavyBeforeShellPaint,
          heavyAfterMobileFallback,
          webglProbeCallsAtShell,
          webglProbeCallsAfterRenderer: webglProbeCalls,
          settled: {
            svgMode: mapHost.classList.contains('svg-mode'),
            deckMode: mapHost.classList.contains('deckgl-mode'),
            width: settledRect.width,
            height: settledRect.height,
          },
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.shellState.hasShellClass).toBe(true);
    expect(result.shellState.ariaBusy).toBe('true');
    expect(result.shellState.pendingRenderer).toBe('svg');
    expect(result.shellState.shellChildCount).toBe(1);
    expect(result.shellState.width).toBeGreaterThan(0);
    expect(result.shellState.height).toBeGreaterThan(0);
    expect(result.heavyAfterMapContainerImport).toEqual([]);
    expect(result.heavyBeforeShellPaint).toEqual([]);
    expect(result.heavyAfterMobileFallback).toEqual([]);
    expect(result.webglProbeCallsAtShell).toBe(0);
    expect(result.settled.svgMode).toBe(true);
    expect(result.settled.deckMode).toBe(false);
    expect(Math.abs(result.settled.width - result.shellState.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(result.settled.height - result.shellState.height)).toBeLessThanOrEqual(1);
  });

  test('MapContainer waits for desktop map demand before heavy WebGL resources', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();

      const isHeavyMapResource = (name: string): boolean =>
        /DeckGLMap|maplibre|deck-stack|pmtiles|\.pmtiles|@deck\.gl|@luma\.gl|@loaders\.gl/i.test(name);
      const heavyResourceNames = (): string[] =>
        performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter(isHeavyMapResource);
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

      performance.clearResourceTimings();
      const { MapContainer } = await import('/src/components/MapContainer.ts');
      const heavyAfterMapContainerImport = heavyResourceNames();

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '960px';
      mapHost.style.height = '360px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const fakeDebugInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };
      const fakeWebGL2 = {
        getExtension(name: string) {
          return name === 'WEBGL_debug_renderer_info' ? fakeDebugInfo : null;
        },
        getParameter() {
          return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)';
        },
      };
      let map: InstanceType<typeof MapContainer> | null = null;

      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown,
        ) {
          if (contextId === 'webgl2') return fakeWebGL2 as unknown as RenderingContext;
          return Reflect.apply(originalGetContext, this, [contextId, options]);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });

        await nextFrame();
        await nextFrame();
        const shellRect = mapHost.getBoundingClientRect();
        await wait(700);

        return {
          heavyAfterMapContainerImport,
          heavyBeforeDemand: heavyResourceNames(),
          shellState: {
            hasShellClass: mapHost.classList.contains('map-renderer-shell'),
            ariaBusy: mapHost.getAttribute('aria-busy'),
            pendingRenderer: mapHost.dataset.mapRendererPending ?? null,
            deckMode: mapHost.classList.contains('deckgl-mode'),
            svgMode: mapHost.classList.contains('svg-mode'),
            width: shellRect.width,
            height: shellRect.height,
          },
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.heavyAfterMapContainerImport).toEqual([]);
    expect(result.heavyBeforeDemand).toEqual([]);
    expect(result.shellState.hasShellClass).toBe(true);
    expect(result.shellState.ariaBusy).toBe('true');
    expect(result.shellState.pendingRenderer).toBe('deck');
    expect(result.shellState.deckMode).toBe(false);
    expect(result.shellState.svgMode).toBe(false);
    expect(result.shellState.width).toBeGreaterThan(0);
    expect(result.shellState.height).toBeGreaterThan(0);
  });

  test('MapContainer starts desktop WebGL resources on first map interaction', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();

      const isHeavyMapResource = (name: string): boolean =>
        /DeckGLMap|maplibre|deck-stack|pmtiles|\.pmtiles|@deck\.gl|@luma\.gl|@loaders\.gl/i.test(name);
      const heavyResourceNames = (): string[] =>
        performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .filter(isHeavyMapResource);
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      const waitForHeavyResource = async (): Promise<string[]> => {
        const deadline = performance.now() + 5_000;
        while (performance.now() < deadline) {
          const names = heavyResourceNames();
          if (names.length > 0) return names;
          await wait(50);
        }
        return heavyResourceNames();
      };

      performance.clearResourceTimings();
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '960px';
      mapHost.style.height = '360px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const fakeDebugInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };
      const fakeWebGL2 = {
        getExtension(name: string) {
          return name === 'WEBGL_debug_renderer_info' ? fakeDebugInfo : null;
        },
        getParameter() {
          return 'ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)';
        },
      };
      let map: InstanceType<typeof MapContainer> | null = null;

      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown,
        ) {
          if (contextId === 'webgl2') return fakeWebGL2 as unknown as RenderingContext;
          return Reflect.apply(originalGetContext, this, [contextId, options]);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });

        await nextFrame();
        await nextFrame();
        await wait(100);
        const heavyBeforeInteraction = heavyResourceNames();
        mapHost.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
        const heavyAfterInteraction = await waitForHeavyResource();

        return {
          heavyBeforeInteraction,
          heavyAfterInteraction,
          pendingRenderer: mapHost.dataset.mapRendererPending ?? null,
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.heavyBeforeInteraction).toEqual([]);
    expect(result.pendingRenderer).toBe('deck');
    expect(result.heavyAfterInteraction.some((name) => (
      /DeckGLMap|maplibre|@deck\.gl|@luma\.gl|@loaders\.gl/i.test(name)
    ))).toBe(true);
  });

  test('MapContainer replays escalation getter setup after deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        initEscalationGetters: () => void;
      };
      const originalInitEscalationGetters = proto.initEscalationGetters;
      let initCalls = 0;
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.initEscalationGetters = function (this: InstanceType<typeof MapComponent>): void {
        initCalls += 1;
        originalInitEscalationGetters.call(this);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.initEscalationGetters();
        const callsBeforeRenderer = initCalls;

        await waitForSvgRenderer(mapHost);

        return {
          callsBeforeRenderer,
          callsAfterRenderer: initCalls,
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.initEscalationGetters = originalInitEscalationGetters;
      }
    });

    expect(result.callsBeforeRenderer).toBe(0);
    expect(result.callsAfterRenderer).toBe(1);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer replays pending view and zoom after deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        setView: (view: string, zoom?: number) => void;
        setZoom: (zoom: number) => void;
      };
      const originalSetView = proto.setView;
      const originalSetZoom = proto.setZoom;
      const viewCalls: Array<{ view: string; zoom?: number }> = [];
      const zoomCalls: number[] = [];
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.setView = function (this: InstanceType<typeof MapComponent>, view: string, zoom?: number): void {
        viewCalls.push({ view, zoom });
        originalSetView.call(this, view as never, zoom);
      };
      proto.setZoom = function (this: InstanceType<typeof MapComponent>, zoom: number): void {
        zoomCalls.push(zoom);
        originalSetZoom.call(this, zoom);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.setView('mena', 4);
        map.setZoom(5);
        const callsBeforeRenderer = { view: viewCalls.length, zoom: zoomCalls.length };

        await waitForSvgRenderer(mapHost);

        return {
          callsBeforeRenderer,
          viewCalls,
          zoomCalls,
          state: map.getState(),
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.setView = originalSetView;
        proto.setZoom = originalSetZoom;
      }
    });

    expect(result.callsBeforeRenderer).toEqual({ view: 0, zoom: 0 });
    expect(result.viewCalls).toEqual([{ view: 'mena', zoom: 4 }]);
    expect(result.zoomCalls).toEqual([5]);
    expect(result.state.view).toBe('mena');
    expect(result.state.zoom).toBe(5);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer applies pending time range before deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        setTimeRange: (range: string) => void;
      };
      const originalSetTimeRange = proto.setTimeRange;
      const rendererRanges: string[] = [];
      const callbackRanges: string[] = [];
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.setTimeRange = function (this: InstanceType<typeof MapComponent>, range: string): void {
        rendererRanges.push(range);
        originalSetTimeRange.call(this, range as never);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.onTimeRangeChanged((range) => callbackRanges.push(range));
        map.setTimeRange('24h');
        const beforeRenderer = {
          callbackRanges: [...callbackRanges],
          rendererRanges: [...rendererRanges],
          timeRange: map.getTimeRange(),
        };

        await waitForSvgRenderer(mapHost);

        return {
          beforeRenderer,
          afterRenderer: {
            callbackRanges,
            rendererRanges,
            timeRange: map.getTimeRange(),
            stateRange: map.getState().timeRange,
          },
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.setTimeRange = originalSetTimeRange;
      }
    });

    expect(result.beforeRenderer).toEqual({
      callbackRanges: ['24h'],
      rendererRanges: [],
      timeRange: '24h',
    });
    expect(result.afterRenderer.callbackRanges).toEqual(['24h']);
    expect(result.afterRenderer.rendererRanges).toEqual([]);
    expect(result.afterRenderer.timeRange).toBe('24h');
    expect(result.afterRenderer.stateRange).toBe('24h');
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer replays hidden layer toggles after deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        hideLayerToggle: (layer: string) => void;
      };
      const originalHideLayerToggle = proto.hideLayerToggle;
      const hiddenLayers: string[] = [];
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.hideLayerToggle = function (this: InstanceType<typeof MapComponent>, layer: string): void {
        hiddenLayers.push(layer);
        originalHideLayerToggle.call(this, layer as never);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.hideLayerToggle('outages');
        const callsBeforeRenderer = hiddenLayers.length;

        await waitForSvgRenderer(mapHost);

        return {
          callsBeforeRenderer,
          hiddenLayers,
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.hideLayerToggle = originalHideLayerToggle;
      }
    });

    expect(result.callsBeforeRenderer).toBe(0);
    expect(result.hiddenLayers).toEqual(['outages']);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer preserves early enabled layers for deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        enableLayer: (layer: string) => void;
      };
      const originalEnableLayer = proto.enableLayer;
      const enableCalls: string[] = [];
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.enableLayer = function (this: InstanceType<typeof MapComponent>, layer: string): void {
        enableCalls.push(layer);
        originalEnableLayer.call(this, layer as never);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 2.5,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS, outages: false },
          timeRange: '7d',
        });
        map.enableLayer('outages');
        const beforeRenderer = {
          enableCalls: [...enableCalls],
          layerEnabled: map.getState().layers.outages,
        };

        await waitForSvgRenderer(mapHost);

        return {
          beforeRenderer,
          afterRenderer: {
            enableCalls,
            layerEnabled: map.getState().layers.outages,
          },
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.enableLayer = originalEnableLayer;
      }
    });

    expect(result.beforeRenderer).toEqual({ enableCalls: [], layerEnabled: true });
    expect(result.afterRenderer.enableCalls).toEqual([]);
    expect(result.afterRenderer.layerEnabled).toBe(true);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer replays early chokepoint data after deferred renderer mount', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapComponent } = await import('/src/components/Map.ts');
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const proto = MapComponent.prototype as {
        setChokepointData: (data: unknown) => void;
      };
      const originalChokepoint = proto.setChokepointData;
      let calls = 0;
      const nextFrame = (): Promise<void> => new Promise((resolve) => requestAnimationFrame(() => resolve()));
      const waitForSvgRenderer = async (host: HTMLElement): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!host.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('SVG renderer did not settle');
          await nextFrame();
        }
      };

      proto.setChokepointData = function (this: InstanceType<typeof MapComponent>, data: unknown): void {
        if (data) calls += 1;
        originalChokepoint.call(this, data as never);
      };

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '390px';
      mapHost.style.height = '260px';
      mapHost.style.position = 'relative';
      document.body.appendChild(mapHost);

      let map: InstanceType<typeof MapContainer> | null = null;
      try {
        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        map.setChokepointData({ chokepoints: [] } as never);
        const callsBeforeRenderer = calls;

        await waitForSvgRenderer(mapHost);

        return {
          callsBeforeRenderer,
          callsAfterRenderer: calls,
          svgMode: mapHost.classList.contains('svg-mode'),
        };
      } finally {
        map?.destroy();
        mapHost.remove();
        proto.setChokepointData = originalChokepoint;
      }
    });

    expect(result.callsBeforeRenderer).toBe(0);
    expect(result.callsAfterRenderer).toBe(1);
    expect(result.svgMode).toBe(true);
  });

  test('MapContainer falls back to SVG when WebGL2 is unavailable', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '1200px';
      mapHost.style.height = '720px';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      let map: InstanceType<typeof MapContainer> | null = null;
      const waitForRenderer = async (): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!mapHost.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('Map renderer did not settle');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };

      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          if (contextId === 'webgl2') return null;
          return Reflect.apply(originalGetContext, this, [contextId, options]);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        await new Promise<void>((resolve) => requestAnimationFrame(() => {
          requestAnimationFrame(() => window.setTimeout(resolve, 0));
        }));
        mapHost.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        await waitForRenderer();

        return {
          isDeckGLMode: map.isDeckGLMode(),
          hasSvgModeClass: mapHost.classList.contains('svg-mode'),
          hasDeckModeClass: mapHost.classList.contains('deckgl-mode'),
          deckWrapperCount: mapHost.querySelectorAll('.deckgl-map-wrapper').length,
          svgWrapperCount: mapHost.querySelectorAll('.map-wrapper').length,
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.isDeckGLMode).toBe(false);
    expect(result.hasSvgModeClass).toBe(true);
    expect(result.hasDeckModeClass).toBe(false);
    expect(result.deckWrapperCount).toBe(0);
    expect(result.svgWrapperCount).toBe(1);
  });

  test('MapContainer clears partial DeckGL DOM after constructor failure fallback', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '1200px';
      mapHost.style.height = '720px';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      const originalGetElementById = Document.prototype.getElementById;
      let map: InstanceType<typeof MapContainer> | null = null;
      const waitForRenderer = async (): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!mapHost.classList.contains('svg-mode')) {
          if (performance.now() > deadline) throw new Error('Map renderer did not settle');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };

      try {
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          if (contextId === 'webgl2') {
            return {
              getExtension: () => null,
              getParameter: () => null,
            } as unknown as WebGL2RenderingContext;
          }
          return Reflect.apply(originalGetContext, this, [contextId, options]);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        Document.prototype.getElementById = (function (
          this: Document,
          id: string
        ): HTMLElement | null {
          if (id === 'deckgl-basemap') {
            throw new Error('forced DeckGL init failure');
          }
          return originalGetElementById.call(this, id);
        }) as typeof Document.prototype.getElementById;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        await waitForRenderer();

        return {
          isDeckGLMode: map.isDeckGLMode(),
          hasSvgModeClass: mapHost.classList.contains('svg-mode'),
          hasDeckModeClass: mapHost.classList.contains('deckgl-mode'),
          deckWrapperCount: mapHost.querySelectorAll('.deckgl-map-wrapper').length,
          svgWrapperCount: mapHost.querySelectorAll('.map-wrapper').length,
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        Document.prototype.getElementById = originalGetElementById;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.isDeckGLMode).toBe(false);
    expect(result.hasSvgModeClass).toBe(true);
    expect(result.hasDeckModeClass).toBe(false);
    expect(result.deckWrapperCount).toBe(0);
    expect(result.svgWrapperCount).toBe(1);
  });

  test('MapContainer falls back to SVG for software WebGL renderers', async ({ page }) => {
    await page.goto('/tests/runtime-harness.html');

    const result = await page.evaluate(async () => {
      const { DEFAULT_MAP_LAYERS } = await import('/src/config/index.ts');
      const { initI18n } = await import('/src/services/i18n.ts');
      await initI18n();
      const { MapContainer } = await import('/src/components/MapContainer.ts');

      const mapHost = document.createElement('div');
      mapHost.className = 'map-container';
      mapHost.style.width = '1200px';
      mapHost.style.height = '720px';
      document.body.appendChild(mapHost);

      const originalGetContext = HTMLCanvasElement.prototype.getContext;
      let map: InstanceType<typeof MapContainer> | null = null;
      const waitForRenderer = async (): Promise<void> => {
        const deadline = performance.now() + 5_000;
        while (!(
          mapHost.classList.contains('svg-mode')
          || mapHost.classList.contains('deckgl-mode')
        )) {
          if (performance.now() > deadline) throw new Error('Map renderer did not settle');
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      };

      try {
        const rendererInfo = { UNMASKED_RENDERER_WEBGL: 0x9246 };
        HTMLCanvasElement.prototype.getContext = (function (
          this: HTMLCanvasElement,
          contextId: string,
          options?: unknown
        ) {
          if (contextId === 'webgl2') {
            return {
              getExtension: (name: string) => name === 'WEBGL_debug_renderer_info' ? rendererInfo : null,
              getParameter: (param: number) => param === rendererInfo.UNMASKED_RENDERER_WEBGL ? 'Google SwiftShader' : null,
            } as unknown as WebGL2RenderingContext;
          }
          return Reflect.apply(originalGetContext, this, [contextId, options]);
        }) as typeof HTMLCanvasElement.prototype.getContext;

        map = new MapContainer(mapHost, {
          zoom: 1,
          pan: { x: 0, y: 0 },
          view: 'global',
          layers: { ...DEFAULT_MAP_LAYERS },
          timeRange: '7d',
        });
        await waitForRenderer();

        return {
          isDeckGLMode: map.isDeckGLMode(),
          hasSvgModeClass: mapHost.classList.contains('svg-mode'),
          hasDeckModeClass: mapHost.classList.contains('deckgl-mode'),
          deckWrapperCount: mapHost.querySelectorAll('.deckgl-map-wrapper').length,
          svgWrapperCount: mapHost.querySelectorAll('.map-wrapper').length,
        };
      } finally {
        HTMLCanvasElement.prototype.getContext = originalGetContext;
        map?.destroy();
        mapHost.remove();
      }
    });

    expect(result.isDeckGLMode).toBe(false);
    expect(result.hasSvgModeClass).toBe(true);
    expect(result.hasDeckModeClass).toBe(false);
    expect(result.deckWrapperCount).toBe(0);
    expect(result.svgWrapperCount).toBe(1);
  });

});
