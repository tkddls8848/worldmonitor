import fs from 'node:fs';
import path from 'node:path';
import { feature as topojsonFeature } from 'topojson-client';
import { resolveIso2 } from './_country-resolver.mjs';

const LEVEL_FOR_INTENSITY = Object.freeze({ high: 'high', medium: 'medium', low: 'tension' });
const RANK = Object.freeze({ null: 0, tension: 1, medium: 2, high: 3 });

function inRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function contains(shape, lon, lat) {
  const polygons = shape.type === 'MultiPolygon' ? shape.coordinates : [shape.coordinates];
  return polygons.some(([outer, ...holes]) => inRing(lon, lat, outer) && !holes.some((hole) => inRing(lon, lat, hole)));
}

/** Map curated zone centres to the containing country; offshore centres are omitted. */
export function buildConflictZoneLevels(zones, rootDir) {
  const topology = JSON.parse(fs.readFileSync(path.join(rootDir, 'public', 'data', 'countries-50m.json'), 'utf8'));
  const countries = topology.objects.countries.geometries.map((geometry) => {
    const { geometry: shape } = topojsonFeature(topology, geometry);
    return { iso2: resolveIso2({ name: geometry.properties?.name }), shape };
  }).filter((entry) => entry.iso2);
  const levels = {};
  for (const zone of zones ?? []) {
    const [lon, lat] = zone.center ?? [];
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const country = countries.find(({ shape }) => contains(shape, lon, lat));
    const level = LEVEL_FOR_INTENSITY[zone.intensity];
    if (!country || !level) continue;
    if (RANK[level] > RANK[levels[country.iso2] ?? 'null']) levels[country.iso2] = level;
  }
  return levels;
}
