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

/** Control point that bows the line sideways by 18% of its length (always to the same side of from→to). */
function curveControl(line: WorldLineView): [number, number] {
  const [x0, y0] = line.fromCoord; const [x1, y1] = line.toCoord;
  const dx = x1 - x0; const dy = y1 - y0;
  const bow = 0.18;
  return [(x0 + x1) / 2 - dy * bow, (y0 + y1) / 2 + dx * bow];
}

/** Point at t on the quadratic curve from → control → to. */
function curveAt(line: WorldLineView, control: [number, number], t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * line.fromCoord[0] + 2 * u * t * control[0] + t * t * line.toCoord[0],
    u * u * line.fromCoord[1] + 2 * u * t * control[1] + t * t * line.toCoord[1],
  ];
}

/** Midpoint of the drawn curve (where the trend tag sits). */
export function curveMidpoint(line: WorldLineView): [number, number] {
  return curveAt(line, curveControl(line), 0.5);
}

const CURVE_STEPS = 32;
/** Dashed lines need finer sampling so each dash spans several vertices. */
const DASHED_CURVE_STEPS = 192;

function segmentedPath(line: WorldLineView): [number, number][][] {
  const control = curveControl(line);
  const points: [number, number][] = [];
  const dash = WORLD_RELATION_DASH[line.kind];
  const steps = dash ? DASHED_CURVE_STEPS : CURVE_STEPS;
  for (let i = 0; i <= steps; i++) points.push(curveAt(line, control, i / steps));
  if (!dash) return [points];
  const [on, off] = dash;
  // Pixel-pattern dashes are approximated by stable geographic segments along
  // the curve. At world zoom this keeps the distinction without a shader extension.
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  if (!total) return [points];
  const periods = Math.max(2, Math.min(24, Math.ceil(total * 3)));
  const period = total / periods;
  const dashLength = period * on / (on + off);
  const paths: [number, number][][] = [];
  let current: [number, number][] = [];
  let walked = 0;
  for (let i = 0; i < points.length; i++) {
    if (i > 0) walked += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
    const inDash = (walked % period) <= dashLength;
    if (inDash) current.push(points[i]!);
    else if (current.length) {
      if (current.length > 1) paths.push(current);
      current = [];
    }
  }
  if (current.length > 1) paths.push(current);
  return paths.length ? paths : [points];
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
      getPosition: (line) => curveMidpoint(line),
      getText: (line) => line.worsening ? '▲ 악화' : '▼ 완화',
      getColor: (line) => WORLD_RELATION_COLORS[theme][line.kind], getSize: 11,
      sizeUnits: 'pixels', getTextAnchor: 'middle', getAlignmentBaseline: 'center',
      background: true, getBackgroundColor: theme === 'light' ? [255, 255, 255, 220] : [20, 22, 21, 220],
      backgroundPadding: [3, 2], pickable: false,
    }));
  }
  return layers;
}
