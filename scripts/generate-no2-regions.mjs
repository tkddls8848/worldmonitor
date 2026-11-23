#!/usr/bin/env node
// Generates the NO2 activity region registry (#9722):
//   scripts/shared/no2-regions.generated.mjs        every region the seeder refreshes
//   scripts/shared/no2-region-geometries.generated.json  country polygons for regional masks
//
// Countries come from public/data/countries.geojson (every ISO 3166-1 alpha-2
// feature with geometry, Antarctica excluded); the industrial clusters are the
// table below. The old per-region resolution and pixel count stay in the
// registry for compatibility. The NASA source uses one 0.25-degree grid.
//
// Regenerate: node scripts/generate-no2-regions.mjs
// Check:      node scripts/generate-no2-regions.mjs --check

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const NO2_REGIONS_PATH = 'scripts/shared/no2-regions.generated.mjs';
export const NO2_GEOMETRIES_PATH = 'scripts/shared/no2-region-geometries.generated.json';
const COUNTRIES_PATH = 'public/data/countries.geojson';

export const RESOLUTIONS_DEGREES = Object.freeze([0.05, 0.1, 0.25, 0.5, 1]);
export const MAX_PIXELS_PER_REQUEST = 10_000;
/** Below this many pixels at the finest grid a bounding box has no stable mean. */
export const MIN_PIXELS = 100;
const EXCLUDED_COUNTRIES = new Set(['AQ']);
const LUNAR_NEW_YEAR_COUNTRIES = new Set(['CN', 'HK', 'MO', 'TW', 'VN', 'KR', 'SG', 'MY']);

/** Industrial clusters: [id, label, host country or null, west, south, east, north]. */
export const CLUSTERS = Object.freeze([
  ['jing-jin-ji', 'Jing-Jin-Ji (Beijing, Tianjin, Hebei)', 'CN', 114, 36, 119, 41],
  ['yangtze-river-delta', 'Yangtze River Delta (Shanghai, southern Jiangsu, northern Zhejiang)', 'CN', 118.5, 30, 122, 32.5],
  ['pearl-river-delta', 'Pearl River Delta (Guangdong manufacturing belt)', 'CN', 112.5, 21.5, 115, 24],
  ['shandong', 'Shandong (Jinan, Zibo, Weifang, Qingdao)', 'CN', 116.5, 34.5, 122.5, 38],
  ['seoul-incheon', 'Seoul-Incheon', 'KR', 126.3, 36.9, 127.6, 37.9],
  ['busan-ulsan', 'Busan-Ulsan', 'KR', 128.6, 34.9, 129.7, 35.9],
  ['tokyo-kanto', 'Tokyo-Kanto', 'JP', 138.8, 35, 140.9, 36.5],
  ['osaka-kansai', 'Osaka-Kansai', 'JP', 134.8, 34.2, 136.2, 35.2],
  ['taiwan-west-coast', 'Taiwan west coast (Taipei to Kaohsiung)', 'TW', 120, 22.4, 121.3, 25.3],
  ['indo-gangetic-plain', 'Indo-Gangetic plain (Delhi to Patna)', 'IN', 76, 24.5, 86, 29.5],
  ['mumbai-pune', 'Mumbai-Pune', 'IN', 72.6, 18.2, 74.2, 19.6],
  ['karachi', 'Karachi', 'PK', 66.6, 24.5, 67.6, 25.3],
  ['jakarta', 'Greater Jakarta', 'ID', 106.3, -6.8, 107.3, -5.9],
  ['bangkok', 'Bangkok metropolitan region', 'TH', 100, 13.2, 101.2, 14.2],
  ['ho-chi-minh-city', 'Ho Chi Minh City and Dong Nai', 'VN', 106.2, 10.4, 107.2, 11.2],
  ['gulf-states', 'Gulf states (Dammam, Doha, Abu Dhabi, Dubai)', null, 49, 23.5, 56.5, 27],
  ['tehran', 'Tehran', 'IR', 50.5, 35.2, 52, 36],
  ['istanbul-marmara', 'Istanbul-Marmara', 'TR', 27.5, 40.2, 30.5, 41.3],
  ['cairo-nile-delta', 'Cairo and the Nile Delta', 'EG', 30.3, 29.5, 32, 31.3],
  ['lagos', 'Lagos', 'NG', 2.8, 6.2, 4, 6.9],
  ['gauteng-highveld', 'Gauteng-Highveld', 'ZA', 27, -27.5, 30.5, -25.5],
  ['ruhr-rhine', 'Ruhr-Rhine', 'DE', 6, 50.3, 8, 52],
  ['po-valley', 'Po Valley', 'IT', 7.5, 44.5, 12.5, 46],
  ['rotterdam-antwerp', 'Rotterdam-Antwerp port belt', null, 3.5, 51, 5.5, 52.3],
  ['upper-silesia', 'Upper Silesia', 'PL', 18, 49.8, 20, 50.6],
  ['moscow', 'Moscow region', 'RU', 36.5, 55, 38.5, 56.2],
  ['us-gulf-coast', 'US Gulf Coast (Houston to Lake Charles)', 'US', -96, 28.5, -92.5, 30.5],
  ['ohio-valley', 'Ohio Valley', 'US', -86, 37.5, -80, 41],
  ['mexico-city', 'Mexico City', 'MX', -99.5, 19, -98.5, 19.9],
  ['sao-paulo', 'Sao Paulo', 'BR', -47.5, -24.2, -45.8, -23],
  ['santiago', 'Santiago', 'CL', -71, -33.8, -70.3, -33.1],
  ['buenos-aires', 'Buenos Aires', 'AR', -59, -35, -57.8, -34.2],
]);

const round = (value, digits = 2) => Number(value.toFixed(digits));

export function pixelsFor(bbox, resolution) {
  return Math.ceil((bbox[2] - bbox[0]) / resolution) * Math.ceil((bbox[3] - bbox[1]) / resolution);
}

export function resolutionFor(bbox, maxPixels = MAX_PIXELS_PER_REQUEST) {
  return RESOLUTIONS_DEGREES.find((resolution) => pixelsFor(bbox, resolution) <= maxPixels)
    ?? RESOLUTIONS_DEGREES[RESOLUTIONS_DEGREES.length - 1];
}

function polygons(geometry) {
  if (geometry?.type === 'Polygon') return [geometry.coordinates];
  if (geometry?.type === 'MultiPolygon') return geometry.coordinates;
  return [];
}

function bboxOf(polys) {
  let west = Infinity; let south = Infinity; let east = -Infinity; let north = -Infinity;
  for (const poly of polys) {
    for (const [lon, lat] of poly[0]) {
      west = Math.min(west, lon); east = Math.max(east, lon);
      south = Math.min(south, lat); north = Math.max(north, lat);
    }
  }
  return [west, south, east, north];
}

/**
 * A country whose polygons sit on both sides of the antimeridian keeps the
 * side holding most of its coordinates to preserve the regional footprint
 * used by the existing registry and its map layer.
 */
function majoritySide(polys) {
  const [west, , east] = bboxOf(polys);
  if (east - west <= 180) return polys;
  let eastern = 0; let western = 0;
  for (const poly of polys) for (const [lon] of poly[0]) (lon >= 0 ? eastern++ : western++);
  return polys.filter((poly) => poly[0].every(([lon]) => (eastern >= western ? lon >= 0 : lon <= 0)));
}

function region(id, kind, label, countryCode, bbox) {
  const resolutionDegrees = resolutionFor(bbox);
  return {
    id,
    kind,
    label,
    countryCode,
    bbox: bbox.map((edge) => round(edge)),
    resolutionDegrees,
    pixels: pixelsFor(bbox, resolutionDegrees),
    holidayCalendar: countryCode !== null && LUNAR_NEW_YEAR_COUNTRIES.has(countryCode) ? 'lunar_new_year' : null,
  };
}

export function buildRegistry(geojson = JSON.parse(readFileSync(join(ROOT, COUNTRIES_PATH), 'utf8'))) {
  const regions = [];
  const geometries = {};
  const skipped = [];
  for (const [id, label, countryCode, ...bbox] of CLUSTERS) {
    regions.push(region(id, 'cluster', label, countryCode, bbox));
  }
  const countries = geojson.features
    .filter((feature) => /^[A-Z]{2}$/.test(feature.properties?.['ISO3166-1-Alpha-2'] ?? '') && feature.geometry)
    .sort((left, right) => left.properties['ISO3166-1-Alpha-2'].localeCompare(right.properties['ISO3166-1-Alpha-2'], 'en-US'));
  for (const feature of countries) {
    const iso2 = feature.properties['ISO3166-1-Alpha-2'];
    if (EXCLUDED_COUNTRIES.has(iso2)) continue;
    const polys = majoritySide(polygons(feature.geometry));
    if (polys.length === 0) { skipped.push([iso2, 'no polygon']); continue; }
    const bbox = bboxOf(polys);
    if (pixelsFor(bbox, RESOLUTIONS_DEGREES[0]) < MIN_PIXELS) { skipped.push([iso2, 'too small']); continue; }
    const id = `country-${iso2.toLowerCase()}`;
    regions.push(region(id, 'country', feature.properties.name, iso2, bbox));
    geometries[id] = polys.length === 1
      ? { type: 'Polygon', coordinates: polys[0] }
      : { type: 'MultiPolygon', coordinates: polys };
  }
  const ids = new Set(regions.map((item) => item.id));
  if (ids.size !== regions.length) throw new Error('duplicate region id');
  return { regions, geometries, skipped };
}

export function renderRegistryModule(regions) {
  return [
    '// Generated by scripts/generate-no2-regions.mjs from public/data/countries.geojson and its cluster table. Do not edit.',
    `export default ${JSON.stringify({ source: COUNTRIES_PATH, generator: 'scripts/generate-no2-regions.mjs', regions })};`,
    '',
  ].join('\n');
}

export function renderGeometries(geometries) {
  return `${JSON.stringify(geometries)}\n`;
}

async function main() {
  const check = process.argv.includes('--check');
  const { regions, geometries, skipped } = buildRegistry();
  const moduleText = renderRegistryModule(regions);
  const geometryText = renderGeometries(geometries);
  if (check) {
    const stale = [NO2_REGIONS_PATH, NO2_GEOMETRIES_PATH].filter((path, index) =>
      readFileSync(join(ROOT, path), 'utf8').replaceAll('\r\n', '\n') !== [moduleText, geometryText][index]);
    if (stale.length > 0) {
      console.error(`stale: ${stale.join(', ')} (run node scripts/generate-no2-regions.mjs)`);
      process.exit(1);
    }
    console.log('no2 regions: up to date');
    return;
  }
  writeFileSync(join(ROOT, NO2_REGIONS_PATH), moduleText);
  writeFileSync(join(ROOT, NO2_GEOMETRIES_PATH), geometryText);
  const clusters = regions.filter((item) => item.kind === 'cluster').length;
  console.log(`no2 regions: ${regions.length} (${clusters} clusters, ${regions.length - clusters} countries); skipped ${JSON.stringify(skipped)}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error('FATAL:', error?.message || error);
    process.exit(1);
  });
}
