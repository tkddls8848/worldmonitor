/** A screen offset in CSS pixels: x to the right, y down. */
export interface ScreenOffset {
  x: number;
  y: number;
}

const MERCATOR_TILE = 512;
const MAX_MERCATOR_LAT = 85.051129;

const wrapLon = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** The Web Mercator map centre that draws (lat, lon) `offset` pixels from the container centre at `zoom`. */
export function mercatorCenterForOffset(lat: number, lon: number, zoom: number, offset: ScreenOffset): { lat: number; lon: number } {
  const world = MERCATOR_TILE * 2 ** zoom;
  const phi = (Math.max(-MAX_MERCATOR_LAT, Math.min(MAX_MERCATOR_LAT, lat)) * Math.PI) / 180;
  const x = ((lon + 180) / 360) * world - offset.x;
  const y = (0.5 - Math.log(Math.tan(Math.PI / 4 + phi / 2)) / (2 * Math.PI)) * world - offset.y;
  const centreLat = (2 * Math.atan(Math.exp((0.5 - y / world) * 2 * Math.PI)) - Math.PI / 2) * (180 / Math.PI);
  return { lat: centreLat, lon: wrapLon((x / world) * 360 - 180) };
}

export interface ScreenArea {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const areaOf = (a: ScreenArea) => Math.max(0, a.right - a.left) * Math.max(0, a.bottom - a.top);

/** The largest part of `map` that none of `covers` draws over, trimming one side per cover. */
export function visibleMapArea(map: ScreenArea, covers: ScreenArea[]): ScreenArea {
  let area: ScreenArea = { left: map.left, top: map.top, right: map.right, bottom: map.bottom };
  for (const c of covers) {
    if (c.right <= area.left || c.left >= area.right || c.bottom <= area.top || c.top >= area.bottom) continue;
    const sides: ScreenArea[] = [
      { ...area, right: Math.min(area.right, c.left) },
      { ...area, left: Math.max(area.left, c.right) },
      { ...area, bottom: Math.min(area.bottom, c.top) },
      { ...area, top: Math.max(area.top, c.bottom) },
    ];
    area = sides.reduce((best, side) => (areaOf(side) > areaOf(best) ? side : best));
  }
  return area;
}
