import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWorldOverviewLayers } from '../src/components/map/world-overview-layers';
import { WORLD_DIM_OPACITY, WORLD_FILL_COLORS } from '../src/config/world-overview-palette';
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
  selectedIso2: 'AA', relatedIso2: ['BB'],
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
