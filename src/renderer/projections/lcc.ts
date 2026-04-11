/**
 * Lambert Conformal Conic projection for HRRR (and any GRIB2 template 3.30
 * grid). We precompute the projection constants on the CPU, push them into
 * the fragment shader as uniforms, and do the forward projection per fragment.
 *
 * Given a lon/lat fragment, the shader returns a (u, v) in [0..1] grid-space
 * coordinate, which we then sample the field texture with.
 *
 * Forward LCC (spherical — good enough for visualization, HRRR uses a
 * spherical earth of radius 6_371_229 m):
 *
 *   n  = ln(cos φ1 / cos φ2) / ln(tan(π/4 + φ2/2) / tan(π/4 + φ1/2))
 *   F  = cos φ1 · tan^n(π/4 + φ1/2) / n
 *   ρ  = R·F / tan^n(π/4 + φ/2)
 *   ρ0 = R·F / tan^n(π/4 + φ0/2)
 *   x  = ρ · sin(n·(λ − λ0))
 *   y  = ρ0 − ρ · cos(n·(λ − λ0))
 *
 * HRRR's grid origin in LCC space is the first grid point (la1, lo1) at index
 * (0, 0) with +x east, +y north. So given (x, y) meters from the origin, the
 * texture coord is (x/(dx·(nx-1)), y/(dy·(ny-1))).
 *
 * When the two standard parallels are equal we degenerate to sin(φ1); we
 * handle that in the constants.
 */

import type { LambertConformalGrid } from '../../grib2/types.js';

export interface LccUniforms {
  // Projection constants
  n: number;
  F: number;
  rho0: number;
  lambda0: number;   // radians
  radius: number;    // meters
  // Grid origin (la1, lo1) in meters, in LCC plane
  originX: number;
  originY: number;
  // Grid step in meters
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  // Scan direction: +1 if latitudes/longitudes increase along scan, -1 if they decrease
  scanX: number;
  scanY: number;
}

const DEG = Math.PI / 180;

/** Wrap radians into [-π, π]. GRIB2 stores longitudes in [0, 360°] but
 *  Web Mercator unprojection gives us [-π, π] — they need to live in the
 *  same branch before we subtract. */
function wrapPi(rad: number): number {
  let x = rad;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

export function computeLccUniforms(g: LambertConformalGrid): LccUniforms {
  const phi1 = g.latin1 * DEG;
  const phi2 = g.latin2 * DEG;
  const phi0 = g.lad * DEG;
  // Normalize both lov and lo1 into [-π, π] so they match the range used by
  // the fragment shader (which unprojects Mercator to longitudes in [-π, π]).
  const lambda0 = wrapPi(g.lov * DEG);
  const R = g.earthRadius;

  let n: number;
  if (Math.abs(phi1 - phi2) < 1e-10) {
    n = Math.sin(phi1);
  } else {
    n = Math.log(Math.cos(phi1) / Math.cos(phi2)) /
        Math.log(Math.tan(Math.PI / 4 + phi2 / 2) / Math.tan(Math.PI / 4 + phi1 / 2));
  }
  const F = (Math.cos(phi1) * Math.pow(Math.tan(Math.PI / 4 + phi1 / 2), n)) / n;
  const rho0 = R * F / Math.pow(Math.tan(Math.PI / 4 + phi0 / 2), n);

  // First grid point (la1, lo1) in LCC plane
  const phi1p = g.la1 * DEG;
  const lam1p = wrapPi(g.lo1 * DEG);
  const rho1 = R * F / Math.pow(Math.tan(Math.PI / 4 + phi1p / 2), n);
  // Wrap the theta difference too, in case lo1 and lov happen to straddle
  // the antimeridian in a way that makes the direct subtraction wrap around.
  const theta1 = n * wrapPi(lam1p - lambda0);
  const originX = rho1 * Math.sin(theta1);
  const originY = rho0 - rho1 * Math.cos(theta1);

  // Scanning mode flag table 3.4 (bit 1 = 0x80 MSB-first, bit 2 = 0x40):
  //   bit 1: 0 = +i (scan east),  1 = -i (scan west)
  //   bit 2: 0 = -j (scan south), 1 = +j (scan north — first point at SW corner)
  //
  // When we upload the field to a WebGL texture row-major, row 0 maps to v=0
  // (texture origin at bottom). For a grid that scans north (+j set), the
  // southernmost row is stored first and naturally lands at v=0, so the
  // texture y-axis already points north and no flip is needed (scanY=+1).
  // A grid that scans south (-j, bit 2 clear) stores the northernmost row
  // first, so we flip.
  const scanX = (g.scanMode & 0x80) ? -1 : 1;
  const scanY = (g.scanMode & 0x40) ? 1 : -1;

  return {
    n, F, rho0, lambda0, radius: R,
    originX, originY,
    dx: g.dx, dy: g.dy,
    nx: g.nx, ny: g.ny,
    scanX, scanY,
  };
}

/**
 * Forward LCC (spherical, CPU mirror of the GLSL `lccToGrid`) — given a
 * lon/lat in degrees, return the grid (u, v) in [0, 1]². Values outside the
 * grid return coordinates outside [0, 1]. Used for click-to-inspect sampling
 * on the main thread.
 */
export function lonLatToGridUV(u: LccUniforms, lonDeg: number, latDeg: number): { u: number; v: number } {
  const lon = (lonDeg * Math.PI) / 180;
  const lat = (latDeg * Math.PI) / 180;
  const tanArg = Math.tan(Math.PI / 4 + lat / 2);
  const rho = (u.radius * u.F) / Math.pow(tanArg, u.n);
  const theta = u.n * (lon - u.lambda0);
  const x = rho * Math.sin(theta);
  const y = u.rho0 - rho * Math.cos(theta);
  let gx = (x - u.originX) / (u.dx * (u.nx - 1));
  let gy = (y - u.originY) / (u.dy * (u.ny - 1));
  if (u.scanX < 0) gx = 1 - gx;
  if (u.scanY < 0) gy = 1 - gy;
  return { u: gx, v: gy };
}

/**
 * Inverse LCC (spherical) — given grid (u, v) in [0, 1]², return the
 * geographic (lon, lat) in degrees. Used on the CPU to compute the grid's
 * mercator bounding rectangle for the scalar field layer quad.
 */
export function gridUVToLonLat(u: LccUniforms, gu: number, gv: number): { lon: number; lat: number } {
  // Account for scan direction
  const fu = u.scanX > 0 ? gu : 1 - gu;
  const fv = u.scanY > 0 ? gv : 1 - gv;
  // LCC plane meters
  const x = fu * u.dx * (u.nx - 1) + u.originX;
  const y = fv * u.dy * (u.ny - 1) + u.originY;
  // Inverse LCC
  const rho = Math.sign(u.n) * Math.sqrt(x * x + (u.rho0 - y) * (u.rho0 - y));
  const theta = Math.atan2(x, u.rho0 - y);
  const lat = 2 * Math.atan(Math.pow((u.radius * u.F) / rho, 1 / u.n)) - Math.PI / 2;
  const lon = u.lambda0 + theta / u.n;
  return { lon: lon * 180 / Math.PI, lat: lat * 180 / Math.PI };
}

/**
 * Walk the perimeter of the LCC grid at `samples` steps per edge, forward-
 * project each sample to lon/lat, and return the bounding box. The grid's
 * rectangular outline in LCC plane coordinates becomes a curved quad in
 * lon/lat, so bounding from just the four corners would cut off the middles
 * of the edges — sample the entire perimeter to be safe.
 */
export function gridLonLatBounds(u: LccUniforms, samples = 64): { lonMin: number; lonMax: number; latMin: number; latMax: number } {
  let lonMin = +Infinity, lonMax = -Infinity, latMin = +Infinity, latMax = -Infinity;
  const push = (gu: number, gv: number): void => {
    const { lon, lat } = gridUVToLonLat(u, gu, gv);
    if (lon < lonMin) lonMin = lon;
    if (lon > lonMax) lonMax = lon;
    if (lat < latMin) latMin = lat;
    if (lat > latMax) latMax = lat;
  };
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    push(t, 0);       // bottom edge
    push(t, 1);       // top edge
    push(0, t);       // left edge
    push(1, t);       // right edge
  }
  return { lonMin, lonMax, latMin, latMax };
}

/**
 * Forward Web Mercator: lon/lat degrees → MapLibre unit-square coordinates.
 * Matches `MercatorCoordinate.fromLngLat` but without allocating an object.
 */
export function lonLatToMercator(lonDeg: number, latDeg: number): { x: number; y: number } {
  const x = (lonDeg + 180) / 360;
  const sinLat = Math.sin((latDeg * Math.PI) / 180);
  const y = 0.5 - Math.log((1 + sinLat) / (1 - sinLat)) / (4 * Math.PI);
  return { x, y };
}

/**
 * GLSL snippet: given uniforms `uLcc_*`, project lon/lat (radians) to
 * normalized texture coords. Callers inline this into their fragment shader.
 */
export const LCC_GLSL = /* glsl */ `
uniform float uLccN;
uniform float uLccF;
uniform float uLccRho0;
uniform float uLccLambda0;
uniform float uLccRadius;
uniform vec2  uLccOrigin;
uniform vec2  uLccStep;   // (dx, dy) in meters
uniform vec2  uLccGridSize; // (nx, ny)
uniform vec2  uLccScan;   // (scanX, scanY), +1 or -1

// lonLatRad: (longitude, latitude) in radians
// returns: (u, v) in [0, 1] normalized grid coords, or (-1, -1) if outside
vec2 lccToGrid(vec2 lonLatRad) {
  float lon = lonLatRad.x;
  float lat = lonLatRad.y;
  if (lat <= -1.5707 || lat >= 1.5707) return vec2(-1.0);
  float tanArg = tan(0.78539816 + lat * 0.5);
  if (tanArg <= 0.0) return vec2(-1.0);
  float rho = uLccRadius * uLccF / pow(tanArg, uLccN);
  float theta = uLccN * (lon - uLccLambda0);
  float x = rho * sin(theta);
  float y = uLccRho0 - rho * cos(theta);

  // Shift to grid-origin-based meters, then to [0,1] texture coords.
  float gx = (x - uLccOrigin.x) / (uLccStep.x * (uLccGridSize.x - 1.0));
  float gy = (y - uLccOrigin.y) / (uLccStep.y * (uLccGridSize.y - 1.0));
  gx = uLccScan.x > 0.0 ? gx : 1.0 - gx;
  gy = uLccScan.y > 0.0 ? gy : 1.0 - gy;
  return vec2(gx, gy);
}
`;
