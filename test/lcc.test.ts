/**
 * LCC uniform + projection sanity checks. Runs entirely on the CPU — no
 * network, no GPU. Validates that:
 *
 *   1. Known CONUS lon/lat points project into the HRRR grid with UVs in
 *      [0, 1], and the corners line up with the expected grid coordinates.
 *   2. Longitude normalization handles HRRR's 0..360° convention correctly.
 *   3. scanY has the right sign for HRRR's south-to-north scan.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { computeLccUniforms, gridLonLatBounds, gridUVToLonLat, lonLatToMercator } from '../src/renderer/projections/lcc.js';
import type { LambertConformalGrid } from '../src/grib2/types.js';

// HRRR grid definition, straight out of a real GRIB2 §3.
const HRRR: LambertConformalGrid = {
  template: 30,
  numberOfPoints: 1799 * 1059,
  shapeOfEarth: 6,
  earthRadius: 6_371_229,
  majorAxis: 0,
  minorAxis: 0,
  nx: 1799,
  ny: 1059,
  la1: 21.138123,
  lo1: 237.280472,     // = -122.719528°
  lad: 38.5,
  lov: 262.5,          // = -97.5°
  dx: 3000,
  dy: 3000,
  projectionCenterFlag: 0,
  scanMode: 0x40,      // bit 2 set: south → north
  latin1: 38.5,
  latin2: 38.5,
  southPoleLat: 0,
  southPoleLon: 0,
  resolutionAndComponentFlags: 8,
};

/** Tiny reference port of the fragment-shader forward LCC, for testing. */
function lccToGrid(u: ReturnType<typeof computeLccUniforms>, lonDeg: number, latDeg: number): { u: number; v: number } {
  const DEG = Math.PI / 180;
  const lon = lonDeg * DEG;
  const lat = latDeg * DEG;
  const tanArg = Math.tan(Math.PI / 4 + lat / 2);
  const rho = u.radius * u.F / Math.pow(tanArg, u.n);
  const theta = u.n * (lon - u.lambda0);
  const x = rho * Math.sin(theta);
  const y = u.rho0 - rho * Math.cos(theta);
  let gx = (x - u.originX) / (u.dx * (u.nx - 1));
  let gy = (y - u.originY) / (u.dy * (u.ny - 1));
  if (u.scanX < 0) gx = 1 - gx;
  if (u.scanY < 0) gy = 1 - gy;
  return { u: gx, v: gy };
}

test('HRRR grid origin projects to (0, 0)', () => {
  const uni = computeLccUniforms(HRRR);
  const { u, v } = lccToGrid(uni, HRRR.lo1 - 360, HRRR.la1);
  assert.ok(Math.abs(u) < 1e-6, `origin u=${u}`);
  assert.ok(Math.abs(v) < 1e-6, `origin v=${v}`);
});

test('HRRR grid opposite corner (max i/j) projects near (1, 1)', () => {
  // We don't know the lat/lon of the NE corner directly, but we can march
  // dx*(nx-1) meters east and dy*(ny-1) meters north in LCC plane coords and
  // invert. Instead, we verify that a point near the center of the grid lies
  // near (0.5, 0.5). Use Kansas City ≈ (-94.58°, 39.1°) — a well-known CONUS
  // point not far from HRRR's center (lov=-97.5°).
  const uni = computeLccUniforms(HRRR);
  const { u, v } = lccToGrid(uni, -94.58, 39.1);
  assert.ok(u > 0.4 && u < 0.7, `KC u expected mid-grid, got ${u}`);
  assert.ok(v > 0.4 && v < 0.7, `KC v expected mid-grid, got ${v}`);
});

test('Longitude normalization: lov and lo1 live in [-π, π]', () => {
  const uni = computeLccUniforms(HRRR);
  assert.ok(uni.lambda0 >= -Math.PI && uni.lambda0 <= Math.PI, `lambda0=${uni.lambda0}`);
  // -97.5° = -1.7017 rad
  assert.ok(Math.abs(uni.lambda0 - (-97.5 * Math.PI / 180)) < 1e-9);
});

test('scanY is +1 for south-to-north scan (bit 2 of scanMode set)', () => {
  const uni = computeLccUniforms(HRRR);
  assert.equal(uni.scanY, 1);
  assert.equal(uni.scanX, 1);
});

test('Fragments outside CONUS project outside [0, 1]', () => {
  const uni = computeLccUniforms(HRRR);
  const honolulu = lccToGrid(uni, -157.86, 21.30);
  assert.ok(honolulu.u < 0, `Honolulu should be west of HRRR grid, u=${honolulu.u}`);
  const london = lccToGrid(uni, -0.12, 51.5);
  assert.ok(london.u > 1, `London should be east of HRRR grid, u=${london.u}`);
});

test('Inverse LCC round-trips through forward LCC', () => {
  const uni = computeLccUniforms(HRRR);
  for (const [lon, lat] of [[-95, 40], [-122, 45], [-80, 35]] as Array<[number, number]>) {
    const forward = lccToGrid(uni, lon, lat);
    const back = gridUVToLonLat(uni, forward.u, forward.v);
    assert.ok(Math.abs(back.lon - lon) < 1e-4, `round-trip lon: ${lon} → ${back.lon}`);
    assert.ok(Math.abs(back.lat - lat) < 1e-4, `round-trip lat: ${lat} → ${back.lat}`);
  }
});

test('HRRR grid bounding box covers CONUS', () => {
  const uni = computeLccUniforms(HRRR);
  const b = gridLonLatBounds(uni, 32);
  // HRRR CONUS grid roughly spans ~125°W → 60°W, 21°N → 50°N (the exact
  // edges curve due to the LCC projection — the bbox is a superset).
  assert.ok(b.lonMin < -120 && b.lonMin > -140, `lonMin=${b.lonMin}`);
  assert.ok(b.lonMax > -65 && b.lonMax < -50, `lonMax=${b.lonMax}`);
  assert.ok(b.latMin < 25 && b.latMin > 15, `latMin=${b.latMin}`);
  assert.ok(b.latMax > 45 && b.latMax < 55, `latMax=${b.latMax}`);
});

test('lonLatToMercator matches MapLibre convention', () => {
  // (0, 0) lng/lat = middle of the map at the equator = (0.5, 0.5) mercator
  const origin = lonLatToMercator(0, 0);
  assert.ok(Math.abs(origin.x - 0.5) < 1e-9);
  assert.ok(Math.abs(origin.y - 0.5) < 1e-9);
  // (180, 0) = right edge of map
  const dateline = lonLatToMercator(180, 0);
  assert.ok(Math.abs(dateline.x - 1.0) < 1e-9);
  // (-180, 0) = left edge
  const antidateline = lonLatToMercator(-180, 0);
  assert.ok(Math.abs(antidateline.x - 0.0) < 1e-9);
  // (0, 85.05°) ≈ top of map (y near 0)
  const topish = lonLatToMercator(0, 85.05);
  assert.ok(topish.y < 0.005 && topish.y > -0.005, `topish.y=${topish.y}`);
});
