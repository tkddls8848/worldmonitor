import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getFirstScreenMode,
  getWorldFields,
  setFirstScreenMode,
  setWorldFields,
} from '@/services/world-first-screen-prefs';

const MODE_KEY = 'worldmonitor-first-screen-mode';
const FIELDS_KEY = 'worldmonitor-world-fields';

afterEach(() => {
  localStorage.removeItem(MODE_KEY);
  localStorage.removeItem(FIELDS_KEY);
});

describe('first screen preferences', () => {
  it('defaults to world mode and the default fields', () => {
    expect(getFirstScreenMode()).toBe('world');
    expect(getWorldFields()).toEqual(['military', 'geopolitics']);
  });

  it('validates stored mode and filters invalid fields', () => {
    localStorage.setItem(MODE_KEY, JSON.stringify('unexpected'));
    localStorage.setItem(FIELDS_KEY, JSON.stringify(['politics', 'invalid', 3, 'military']));
    expect(getFirstScreenMode()).toBe('world');
    expect(getWorldFields()).toEqual(['politics', 'military']);
  });

  it('persists mode and only allowed fields', () => {
    setFirstScreenMode('full');
    setWorldFields(['finance', 'military']);
    expect(getFirstScreenMode()).toBe('full');
    expect(getWorldFields()).toEqual(['finance', 'military']);
  });
});

const mountMock = vi.hoisted(() => ({
  onEnter: vi.fn(),
  onLeave: vi.fn(),
  destroy: vi.fn(),
  mount: vi.fn(),
}));

vi.mock('@/app/world-first-screen', () => ({
  mountWorldFirstScreen: (...args: unknown[]) => {
    mountMock.mount(...args);
    return { onEnter: mountMock.onEnter, onLeave: mountMock.onLeave, destroy: mountMock.destroy };
  },
}));

const { PanelLayoutManager } = await import('@/app/panel-layout');

interface FakeMap { setWorldOverviewMode: ReturnType<typeof vi.fn>; resize: ReturnType<typeof vi.fn> }

function modeLayout(): { layout: InstanceType<typeof PanelLayoutManager>; map: FakeMap; build: ReturnType<typeof vi.fn>; container: HTMLElement } {
  document.body.innerHTML = `
    <div id="app">
      <main id="main"><div id="mapSection"><div class="panel-header"></div><div class="map-container" id="mapContainer"></div><div class="map-resize-handle"></div></div></main>
    </div>`;
  const container = document.getElementById('app')!;
  const map: FakeMap = { setWorldOverviewMode: vi.fn(), resize: vi.fn() };
  const layout = Object.create(PanelLayoutManager.prototype) as InstanceType<typeof PanelLayoutManager>;
  Reflect.set(layout, 'ctx', { container, isDestroyed: false, map, panels: {} });
  Reflect.set(layout, 'worldMode', false);
  Reflect.set(layout, 'fullViewBuilt', false);
  Reflect.set(layout, 'fullViewBuilding', null);
  Reflect.set(layout, 'worldScreen', null);
  Reflect.set(layout, 'worldSlots', null);
  Reflect.set(layout, 'fullViewStarter', null);
  Reflect.set(layout, 'callbacks', { openCountryBrief: vi.fn() });
  Reflect.set(layout, 'ensureMap', async () => {});
  const build = vi.fn(async function (this: object) {
    await Promise.resolve();
    Reflect.set(this, 'fullViewBuilt', true);
    (this as unknown as { runFullViewStarter(): void }).runFullViewStarter();
  });
  Reflect.set(layout, 'buildFullView', build);
  return { layout, map, build, container };
}

async function bootWorld(layout: InstanceType<typeof PanelLayoutManager>): Promise<void> {
  await (layout as unknown as { renderWorldFirstScreen(): Promise<void> }).renderWorldFirstScreen();
}

describe('first screen mode switch', () => {
  afterEach(() => {
    document.documentElement.classList.remove('wm-world-mode');
    mountMock.mount.mockClear();
    mountMock.onEnter.mockClear();
  });

  it('world mode moves the one map into the stage and builds no panels', async () => {
    const { layout, map, build } = modeLayout();
    await bootWorld(layout);
    const stage = document.querySelector('#worldFirstScreen .wfs-slot-stage');
    expect(stage?.contains(document.getElementById('mapContainer'))).toBe(true);
    expect(document.documentElement.classList.contains('wm-world-mode')).toBe(true);
    expect(map.setWorldOverviewMode).toHaveBeenCalledWith(true);
    expect(mountMock.mount).toHaveBeenCalledTimes(1);
    expect(build).not.toHaveBeenCalled();
    expect(layout.isWorldMode()).toBe(true);
  });

  it('full view builds once, returns the map to its section and persists the mode', async () => {
    const { layout, map, build } = modeLayout();
    const starter = vi.fn();
    await bootWorld(layout);
    layout.setFullViewStarter(starter);
    await Promise.all([layout.enterFullView(), layout.enterFullView()]);
    const section = document.getElementById('mapSection')!;
    expect(document.getElementById('mapContainer')?.parentElement).toBe(section);
    expect(document.getElementById('mapContainer')?.nextElementSibling?.className).toBe('map-resize-handle');
    expect(map.setWorldOverviewMode).toHaveBeenLastCalledWith(false);
    expect(build).toHaveBeenCalledTimes(1);
    expect(starter).toHaveBeenCalledTimes(1);
    expect(getFirstScreenMode()).toBe('full');
    expect((document.getElementById('worldFirstScreen') as HTMLElement).hidden).toBe(true);
  });

  it('opens the selected country brief after full-view setup, including during a pending switch', async () => {
    const { layout } = modeLayout();
    await bootWorld(layout);
    const hooks = mountMock.mount.mock.lastCall?.[2] as { openCountryBrief(iso2: string): void };
    const openBrief = Reflect.get(layout, 'callbacks').openCountryBrief;
    const build = layout.enterFullView();
    hooks.openCountryBrief('UA');
    expect(openBrief).not.toHaveBeenCalled();
    await build;
    await vi.waitFor(() => expect(openBrief).toHaveBeenCalledWith('UA'));
  });

  it('returning to the world view reuses the shell and does not rebuild the full view', async () => {
    const { layout, map, build } = modeLayout();
    await bootWorld(layout);
    await layout.enterFullView();
    layout.enterWorldView();
    expect(getFirstScreenMode()).toBe('world');
    expect(document.querySelectorAll('#worldFirstScreen')).toHaveLength(1);
    expect(document.querySelector('#worldFirstScreen .wfs-slot-stage')?.contains(document.getElementById('mapContainer'))).toBe(true);
    expect(map.setWorldOverviewMode).toHaveBeenLastCalledWith(true);
    expect(mountMock.onEnter).toHaveBeenCalledTimes(1);
    await layout.enterFullView();
    expect(build).toHaveBeenCalledTimes(1);
  });
});
