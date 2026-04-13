/**
 * Regular lat/lon grid projection for the scalar field shader.
 * Much simpler than LCC — just a linear mapping from lon/lat to grid UV.
 */

export interface LatLonBounds {
  lonMin: number;  // degrees
  lonMax: number;
  latMin: number;
  latMax: number;
}

export interface LatLonUniforms {
  lonMin: number;  // radians
  lonMax: number;
  latMin: number;
  latMax: number;
}

const DEG = Math.PI / 180;

export function computeLatLonUniforms(bounds: LatLonBounds): LatLonUniforms {
  return {
    lonMin: bounds.lonMin * DEG,
    lonMax: bounds.lonMax * DEG,
    latMin: bounds.latMin * DEG,
    latMax: bounds.latMax * DEG,
  };
}

/**
 * CPU-side lon/lat to grid UV for click-to-inspect sampling.
 * Returns (u, v) in [0,1] or out-of-range if outside the grid.
 */
export function lonLatToGridUVLatLon(
  bounds: LatLonBounds,
  lonDeg: number,
  latDeg: number,
): { u: number; v: number } {
  const u = (lonDeg - bounds.lonMin) / (bounds.lonMax - bounds.lonMin);
  const v = (latDeg - bounds.latMin) / (bounds.latMax - bounds.latMin);
  return { u, v };
}

/**
 * Convert lat/lon bounds to MapLibre Mercator unit-square coordinates.
 */
export function latLonBoundsToMercator(bounds: LatLonBounds): {
  mercMin: { x: number; y: number };
  mercMax: { x: number; y: number };
} {
  // MapLibre Mercator: x = (lon + 180) / 360, y = 0.5 - ln(tan(π/4 + φ/2)) / (2π)
  const toMercX = (lonDeg: number): number => (lonDeg + 180) / 360;
  const toMercY = (latDeg: number): number => {
    const latRad = latDeg * DEG;
    return 0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI);
  };

  return {
    mercMin: { x: toMercX(bounds.lonMin), y: toMercY(bounds.latMax) }, // top-left (low y in merc)
    mercMax: { x: toMercX(bounds.lonMax), y: toMercY(bounds.latMin) }, // bottom-right (high y)
  };
}

export const LATLON_GLSL = /* glsl */ `
uniform vec4 uLatLonBounds;  // (lonMin, lonMax, latMin, latMax) in radians

// lonLatRad: (longitude, latitude) in radians
// returns: (u, v) in [0, 1] normalized grid coords
vec2 latlonToGrid(vec2 lonLatRad) {
  float u = (lonLatRad.x - uLatLonBounds.x) / (uLatLonBounds.y - uLatLonBounds.x);
  float v = (lonLatRad.y - uLatLonBounds.z) / (uLatLonBounds.w - uLatLonBounds.z);
  return vec2(u, v);
}
`;
