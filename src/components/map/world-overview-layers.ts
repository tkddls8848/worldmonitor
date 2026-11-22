import { GeoJsonLayer, PathLayer, TextLayer } from '@deck.gl/layers';
import type { Layer } from '@deck.gl/core';
import type { FeatureCollection, Geometry } from 'geojson';
import type { WorldMapView, WorldLineView, ThemeName } from '@/types/world-overview';
import {
  ALLIANCE_EXTRA_WIDTH, WORLD_ARC_CASING, WORLD_BLOC_COLORS, WORLD_DIM_OPACITY,
  WORLD_FILL_COLORS, WORLD_LAND_STROKE, WORLD_LAND_STROKE_WIDTH, WORLD_RELATION_COLORS,
  WORLD_RELATION_DASH, WORLD_RELATION_END, WORLD_TREND_STROKE, WORLD_UNREST_OUTLINE,
} from '@/config/world-overview-palette';

type CountryFeature = GeoJSON.Feature<Geometry, Record<string, unknown>>;
type LinePath = { line: WorldLineView; path: [number, number][] };
type EndMark = { line: WorldLineView; position: [number, number]; end: string };
const ISO_KEYS = ['ISO3166-1-Alpha-2', 'ISO_A2', 'iso_a2'] as const;
const iso2 = (feature: CountryFeature): string => {
  for (const key of ISO_KEYS) {
    const value = feature.properties?.[key];
    if (typeof value === 'string' && value && value !== '-99') return value.toUpperCase();
  }
  return '';
};

function segmentedPath(line: WorldLineView): [number, number][][] {
  const dash = WORLD_RELATION_DASH[line.kind];
  if (!dash) return [[line.fromCoord, line.toCoord]];
  const [on, off] = dash;
  // Pixel-pattern dashes are approximated by stable geographic segments. At
  // world zoom this keeps the visual distinction without a shader extension.
  const dx = line.toCoord[0] - line.fromCoord[0];
  const dy = line.toCoord[1] - line.fromCoord[1];
  const distance = Math.hypot(dx, dy);
  if (!distance) return [[line.fromCoord, line.toCoord]];
  const periods = Math.max(2, Math.min(24, Math.ceil(distance * 3)));
  const periodLength = distance / periods;
  const dashLength = periodLength * on / (on + off);
  const paths: [number, number][][] = [];
  for (let index = 0; index < periods; index++) {
    const start = index * periodLength;
    const end = Math.min(distance, start + dashLength);
    paths.push([
      [line.fromCoord[0] + dx * start / distance, line.fromCoord[1] + dy * start / distance],
      [line.fromCoord[0] + dx * end / distance, line.fromCoord[1] + dy * end / distance],
    ]);
  }
  return paths;
}

function lineTone(line: WorldLineView) {
  return line.worsening ? WORLD_TREND_STROKE.worsening : line.easing ? WORLD_TREND_STROKE.easing : WORLD_TREND_STROKE.steady;
}

export function buildWorldOverviewLayers(
  view: WorldMapView,
  countries: FeatureCollection,
  theme: ThemeName,
  hoverIso2: string | null,
): Layer[] {
  if (!countries.features.length) return [];
  const features = countries.features as CountryFeature[];
  const related = new Set(view.relatedIso2);
  const selected = view.selectedIso2;
  const layers: Layer[] = [new GeoJsonLayer<Record<string, unknown>>({
    id: 'world-overview-fill', data: countries,
    filled: true, stroked: true, pickable: true,
    getFillColor: (feature) => {
      const country = view.countries[iso2(feature)];
      const level = country?.level ?? 0;
      const dim = selected && iso2(feature) !== selected && !related.has(iso2(feature)) ? WORLD_DIM_OPACITY : 1;
      const color = WORLD_FILL_COLORS[theme][level];
      return [color[0], color[1], color[2], Math.round(color[3] * dim)];
    },
    getLineColor: WORLD_LAND_STROKE[theme],
    getLineWidth: (feature) => iso2(feature) === selected ? WORLD_LAND_STROKE_WIDTH.selected : iso2(feature) === hoverIso2 ? WORLD_LAND_STROKE_WIDTH.hover : WORLD_LAND_STROKE_WIDTH.base,
    lineWidthUnits: 'pixels', lineWidthMinPixels: 0.5,
    updateTriggers: { getFillColor: [view, theme], getLineColor: [selected, hoverIso2], getLineWidth: [selected, hoverIso2] },
  })];

  const unrest = features.filter((feature) => view.countries[iso2(feature)]?.unrestOutline);
  if (unrest.length) layers.push(new GeoJsonLayer<Record<string, unknown>>({
    id: 'world-overview-unrest-outline', data: { type: 'FeatureCollection', features: unrest },
    filled: false, stroked: true, getLineColor: WORLD_UNREST_OUTLINE[theme], getLineWidth: 1.8,
    lineWidthUnits: 'pixels', pickable: false,
  }));

  for (const bloc of view.blocOutlines) {
    const members = new Set(bloc.members);
    const blocFeatures = features.filter((feature) => members.has(iso2(feature)));
    if (!blocFeatures.length) continue;
    const colors = WORLD_BLOC_COLORS[theme];
    layers.push(new GeoJsonLayer<Record<string, unknown>>({
      id: `world-overview-bloc-${bloc.blocId}`, data: { type: 'FeatureCollection', features: blocFeatures },
      filled: false, stroked: true, getLineColor: colors[bloc.colorIndex % colors.length], getLineWidth: 1.65,
      lineWidthUnits: 'pixels', pickable: false,
    }));
  }

  const lineData = view.lines.flatMap((line) => segmentedPath(line).map((path) => ({ line, path })));
  if (lineData.length) {
    layers.push(new PathLayer<LinePath>({
      id: 'world-overview-line-casing', data: lineData,
      getPath: (item) => item.path, getColor: WORLD_ARC_CASING[theme],
      getWidth: (item) => lineTone(item.line).width + (item.line.kind === 'alliance' ? ALLIANCE_EXTRA_WIDTH : 0) + 2.4,
      widthUnits: 'pixels', capRounded: true, jointRounded: true, pickable: false,
    }));
    layers.push(new PathLayer<LinePath>({
      id: 'world-overview-lines', data: lineData,
      getPath: (item) => item.path, getColor: (item) => {
        const color = WORLD_RELATION_COLORS[theme][item.line.kind];
        return [color[0], color[1], color[2], Math.round(color[3] * lineTone(item.line).opacity)];
      },
      getWidth: (item) => lineTone(item.line).width + (item.line.kind === 'alliance' ? ALLIANCE_EXTRA_WIDTH : 0),
      widthUnits: 'pixels', capRounded: true, jointRounded: true, pickable: true,
      onClick: (info) => {
        const line = (info.object as { line?: WorldLineView } | undefined)?.line;
        if (line) window.dispatchEvent(new CustomEvent('wm:world-line-click', { detail: { lineId: line.id } }));
      },
      updateTriggers: { getColor: [theme], getWidth: [view] },
    }));
    const endpoints = view.lines.flatMap((line) => {
      const end = WORLD_RELATION_END[line.kind];
      if (end === 'none') return [];
      return [{ line, position: line.toCoord, end }];
    });
    if (endpoints.length) layers.push(new TextLayer<EndMark>({
      id: 'world-overview-line-ends', data: endpoints,
      getPosition: (item) => item.position,
      getText: (item) => item.end === 'arrow' ? '›' : item.end === 'bar' ? '⊣' : item.end === 'dots' ? '••' : '↔',
      getColor: (item) => WORLD_RELATION_COLORS[theme][item.line.kind], getSize: 15,
      sizeUnits: 'pixels', getTextAnchor: 'middle', getAlignmentBaseline: 'center',
      pickable: false,
    }));
    const eligibleTags = view.lines.filter((line) => line.showTag && (line.worsening || line.easing));
    const tags = view.selectedIso2 ? eligibleTags : eligibleTags.slice(0, 6);
    if (tags.length) layers.push(new TextLayer<WorldLineView>({
      id: 'world-overview-line-tags', data: tags,
      getPosition: (line) => [(line.fromCoord[0] + line.toCoord[0]) / 2, (line.fromCoord[1] + line.toCoord[1]) / 2],
      getText: (line) => line.worsening ? '▲ 악화' : '▼ 완화',
      getColor: (line) => WORLD_RELATION_COLORS[theme][line.kind], getSize: 11,
      sizeUnits: 'pixels', getTextAnchor: 'middle', getAlignmentBaseline: 'center',
      background: true, getBackgroundColor: theme === 'light' ? [255, 255, 255, 220] : [20, 22, 21, 220],
      backgroundPadding: [3, 2], pickable: false,
    }));
  }
  return layers;
}
