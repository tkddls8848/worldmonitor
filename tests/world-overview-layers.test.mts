import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorldOverviewLayers } from '../src/components/map/world-overview-layers';
import { WORLD_DIM_OPACITY, WORLD_FILL_COLORS, WORLD_GRID_COLOR, WORLD_HOTSPOT_COLORS, WORLD_TARGET_COLOR } from '../src/config/world-overview-palette';
import type { WorldMapView, WorldLineView } from '../src/types/world-overview';

const countries: GeoJSON.FeatureCollection = {
  type: 'FeatureCollection',
  features: ['AA', 'BB', 'CC', 'DD', 'EE'].map((code) => ({
    type: 'Feature' as const,
    properties: { 'ISO3166-1-Alpha-2': code },
    geometry: { type: 'Polygon' as const, coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] },
  })),
};

const line = (id: string, kind: WorldLineView['kind'] = 'tension'): WorldLineView => ({
  id, origin: 'fixed', kind, field: 'geopolitics', from: 'AA', to: 'BB',
  fromCoord: [0, 0], toCoord: [1, 1], directed: true, trend: 'rising',
  worsening: true, easing: false, showTag: true, label: `label ${id}`, reappeared: false,
});

const view: WorldMapView = {
  date: '2026-11-22',
  countries: {
    AA: { iso2: 'AA', level: 4, unrestOutline: true, blocIds: [] },
    BB: { iso2: 'BB', level: 2, unrestOutline: false, blocIds: ['bloc'] },
    CC: { iso2: 'CC', level: 1, unrestOutline: false, blocIds: [] },
    DD: { iso2: 'DD', level: 3, unrestOutline: false, blocIds: [] },
  },
  lines: [line('a', 'tension'), line('b', 'sanction'), ...Array.from({ length: 7 }, (_, i) => line(`tag-${i}`, 'support'))],
  blocOutlines: [{ blocId: 'bloc', members: ['BB'], colorIndex: 0 }],
  selectedIso2: 'AA', relatedIso2: ['BB'], hotspots: [],
};

test('buildWorldOverviewLayers includes fills, outlines, casing before lines, ends and capped tags', () => {
  const layers = buildWorldOverviewLayers({ ...view, selectedIso2: null }, countries, 'light', null);
  const ids = layers.map((layer) => layer.id);
  assert.ok(ids.includes('world-overview-fill'));
  assert.ok(ids.includes('world-overview-unrest-outline'));
  assert.ok(ids.includes('world-overview-bloc-bloc'));
  assert.ok(ids.includes('world-overview-line-casing'));
  assert.ok(ids.includes('world-overview-lines'));
  assert.ok(ids.includes('world-overview-line-ends'));
  assert.ok(ids.includes('world-overview-line-tags'));
  assert.ok(ids.indexOf('world-overview-line-casing') < ids.indexOf('world-overview-lines'));
  assert.ok((layers.find((layer) => layer.id === 'world-overview-lines')!.props.data as unknown[]).length > view.lines.length, 'dashed relation kinds split into dash segments');
  const tags = layers.find((layer) => layer.id === 'world-overview-line-tags')!;
  assert.equal((tags.props.data as WorldLineView[]).length, 6);
  assert.equal((tags.props.getText as (d: WorldLineView) => string)(line('x')), '▲ 악화');
});

test('fill colours use the requested theme and selected country dimming', () => {
  const feature = countries.features[0] as GeoJSON.Feature<GeoJSON.Geometry, Record<string, unknown>>;
  for (const theme of ['light', 'dark'] as const) {
    const fill = buildWorldOverviewLayers({ ...view, selectedIso2: null }, countries, theme, null).find((layer) => layer.id === 'world-overview-fill')!;
    const getFill = fill.props.getFillColor as (feature: typeof countries.features[number]) => number[];
    assert.deepEqual(getFill(feature), WORLD_FILL_COLORS[theme][4]);
    assert.deepEqual(getFill(countries.features[1]), WORLD_FILL_COLORS[theme][2]);
    assert.deepEqual(getFill(countries.features[3]), WORLD_FILL_COLORS[theme][3]);
    assert.deepEqual(getFill(countries.features[4]), WORLD_FILL_COLORS[theme][0]);
    const selectedFill = buildWorldOverviewLayers(view, countries, theme, null).find((layer) => layer.id === 'world-overview-fill')!;
    const getSelectedFill = selectedFill.props.getFillColor as (feature: typeof countries.features[number]) => number[];
    const nonRelated = countries.features[2];
    const actual = getSelectedFill(nonRelated);
    const base = WORLD_FILL_COLORS[theme][1];
    assert.equal(actual[3], Math.round(base[3] * WORLD_DIM_OPACITY));
  }
});

test('empty view yields no world layers', () => {
  const noData = { ...view, countries: {}, lines: [], blocOutlines: [] };
  assert.equal(buildWorldOverviewLayers(noData, countries, 'dark', null)[0]?.id, 'world-overview-fill');
  assert.deepEqual(buildWorldOverviewLayers(noData, { type: 'FeatureCollection', features: [] }, 'dark', null), []);
});

test('tactical marks render hotspots, selected brackets and dark-only grid', () => {
  const tacticalView: WorldMapView = {
    ...view,
    hotspots: [{ iso2: 'AA', coord: [12, 34], level: 4 }],
  };
  const darkLayers = buildWorldOverviewLayers(tacticalView, countries, 'dark', null, 0.25);
  const ids = darkLayers.map((layer) => layer.id);
  assert.ok(ids.includes('world-overview-hotspots'));
  assert.ok(ids.includes('world-overview-hotspot-labels'));
  assert.ok(ids.includes('world-overview-target'));
  assert.ok(ids.includes('world-overview-target-label'));
  assert.ok(ids.includes('world-overview-grid'));
  const hotspot = darkLayers.find((layer) => layer.id === 'world-overview-hotspots')!;
  assert.deepEqual((hotspot.props.getPosition as (item: { coord: [number, number] }) => number[])(tacticalView.hotspots[0]!), [12, 34]);
  assert.equal((hotspot.props.getRadius as (item: { level: number }) => number)(tacticalView.hotspots[0]!), 22);
  const hotspotLabel = darkLayers.find((layer) => layer.id === 'world-overview-hotspot-labels')!;
  assert.equal((hotspotLabel.props.getText as (item: { iso2: string }) => string)(tacticalView.hotspots[0]!), 'AA');
  let selectedCountry = '';
  const previousWindow = globalThis.window;
  const testWindow = new EventTarget();
  Object.defineProperty(globalThis, 'window', { configurable: true, value: testWindow });
  const clickListener = (event: Event): void => { selectedCountry = (event as CustomEvent<{ code: string }>).detail.code; };
  testWindow.addEventListener('wm:world:country-click', clickListener, { once: true });
  (hotspot.props.onClick as (info: { object: unknown }) => void)({ object: tacticalView.hotspots[0] });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: previousWindow });
  assert.equal(selectedCountry, 'AA');
  // The pulse drives the layer opacity uniform (0.25–0.7), not per-ring colours.
  assert.deepEqual(hotspot.props.getLineColor, WORLD_HOTSPOT_COLORS.dark);
  assert.ok(Math.abs((hotspot.props.opacity as number) - 0.7) < 1e-9);
  assert.deepEqual(darkLayers.find((layer) => layer.id === 'world-overview-target')!.props.getColor, WORLD_TARGET_COLOR.dark);
  assert.equal((darkLayers.find((layer) => layer.id === 'world-overview-target-label')!.props.getText as (item: { iso2: string }) => string)({ iso2: 'AA' }), 'TARGET // AA');
  assert.deepEqual(darkLayers.find((layer) => layer.id === 'world-overview-grid')!.props.getColor, WORLD_GRID_COLOR.dark);
  assert.ok(!buildWorldOverviewLayers(tacticalView, countries, 'light', null).some((layer) => layer.id === 'world-overview-grid'));
  assert.ok(!buildWorldOverviewLayers({ ...tacticalView, selectedIso2: null }, countries, 'dark', null).some((layer) => layer.id === 'world-overview-target'));
});
