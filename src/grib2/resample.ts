/**
 * Resample a Lambert Conformal Conic (LCC) wind field onto a regular
 * latitude/longitude grid, with grid-relative to true-north vector rotation.
 *
 * The vendored `windy.js` renderer (../renderer/layers/vendor/windy.js) only
 * accepts the classic GRIB2 template-0 regular lat/lon payload — it has no
 * notion of LCC. HRRR, on the other hand, ships on a Lambert Conformal grid
 * and stores its u/v components relative to grid-north, not true north. Both
 * of those have to be undone here before windy.js will behave.
 *
 * Steps:
 *   1. Walk the LCC grid perimeter to get a lat/lon bounding rectangle.
 *   2. Choose a target regular-grid resolution (defaults to a CONUS-friendly
 *      ~0.12°, ~600 × 300 cells — roughly an order of magnitude coarser than
 *      HRRR's native 3 km, which is still plenty for particle visualization
 *      and keeps the one-shot resample under ~100 ms on the main thread).
 *   3. For each target cell, forward-project its (lat, lon) into LCC grid
 *      space with `lonLatToGridUV` and bilinearly sample u and v from the
 *      source Float32Arrays.
 *   4. Rotate the sampled (u, v) from grid-relative to true-north using the
 *      LCC grid-convergence angle γ = n · (λ − λ₀). Without this step the
 *      particles visibly curve wrong away from the standard parallels.
 *   5. Emit the result as a windy.js-compatible [U, V] component payload
 *      (one `{header, data}` per component), with a NW-origin scan layout
 *      and scanMode = 0.
 *
 * Out-of-grid target cells are filled with (0, 0) — "no wind" — rather than
 * NaN or null. windy.js's interpolator would propagate NaN through its
 * draw-bucket math and then crash on an undefined bucket lookup, so the
 * harmless stationary value is the safer default. In practice CONUS covers
 * virtually everything inside the LCC bounding box except thin strips over
 * the Gulf / Atlantic / Pacific that are largely off-screen at the zoom
 * levels this demo uses.
 */

import type { WindyComponent } from '../renderer/layers/vendor/windy.js';
import { computeLccUniforms, lonLatToGridUV, gridLonLatBounds } from '../renderer/projections/lcc.js';
import type { DecodedField, LambertConformalGrid } from './types.js';

export interface ResampledWindField {
  /** windy.js-compatible payload, already in [U, V] order. */
  components: [WindyComponent, WindyComponent];
  /** Maximum wind speed observed in the resampled output (m/s). */
  maxSpeed: number;
  /** Lat/lon bounding box of the output grid, degrees. */
  bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number };
}

export interface ResampleOptions {
  /** Target output grid width. Defaults to 600. */
  nx?: number;
  /** Target output grid height. Defaults to 300. */
  ny?: number;
  /** Reference time string for the windy.js header. Defaults to `new Date().toISOString()`. */
  refTime?: string;
  /** Forecast hour for the windy.js header. Defaults to 0. */
  forecastTime?: number;
}

const DEG = Math.PI / 180;

/** Wrap radians to [-π, π] — used when subtracting longitudes across the antimeridian. */
function wrapPi(rad: number): number {
  let x = rad;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x < -Math.PI) x += 2 * Math.PI;
  return x;
}

/**
 * Resample HRRR-style LCC u/v into a windy.js-friendly regular lat/lon grid.
 */
export function resampleLccToLatLon(
  u: DecodedField,
  v: DecodedField,
  grid: LambertConformalGrid,
  options: ResampleOptions = {},
): ResampledWindField {
  if (u.nx !== v.nx || u.ny !== v.ny) {
    throw new Error('u/v grid dimensions must match');
  }
  const srcNx = u.nx;
  const srcNy = u.ny;
  const lcc = computeLccUniforms(grid);
  const bounds = gridLonLatBounds(lcc);

  const targetNx = Math.max(2, options.nx ?? 600);
  const targetNy = Math.max(2, options.ny ?? 300);

  // windy.js expects dx/dy to be the spacing between adjacent grid cells in
  // degrees, NOT the full extent. It also stores rows from north to south,
  // so la1 is the *maximum* latitude (the top row) and lo1 is the minimum
  // longitude (the first column).
  const dx = (bounds.lonMax - bounds.lonMin) / (targetNx - 1);
  const dy = (bounds.latMax - bounds.latMin) / (targetNy - 1);
  const la1 = bounds.latMax;
  const lo1 = bounds.lonMin;

  const uOut = new Float32Array(targetNx * targetNy);
  const vOut = new Float32Array(targetNx * targetNy);

  // Pre-cache the source arrays as plain typed arrays; indexed access on
  // DecodedField.values is ~2× slower through the property path.
  const srcU = u.values;
  const srcV = v.values;
  const lambda0 = lcc.lambda0; // already wrapped to [-π, π]
  const n = lcc.n;

  let maxSpeed = 0;

  for (let j = 0; j < targetNy; j++) {
    // Row 0 is northernmost: lat decreases as j grows.
    const lat = la1 - j * dy;
    for (let i = 0; i < targetNx; i++) {
      const lon = lo1 + i * dx;
      const outIdx = j * targetNx + i;

      // Forward-project lat/lon into the source LCC grid's normalized coords.
      // lonLatToGridUV already folds in the GRIB2 scan sign, so `(gu, gv)` is
      // the same (u, v) that the on-screen windParticles sampleAt uses — we
      // can index the raw values array directly without worrying about
      // scanMode.
      const { u: gu, v: gv } = lonLatToGridUV(lcc, lon, lat);
      if (gu < 0 || gu > 1 || gv < 0 || gv > 1) {
        // Outside the source grid — fill with zero wind. See header comment
        // for why we don't use NaN.
        uOut[outIdx] = 0;
        vOut[outIdx] = 0;
        continue;
      }

      const fx = gu * (srcNx - 1);
      const fy = gv * (srcNy - 1);
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fy);
      const i1 = Math.min(srcNx - 1, i0 + 1);
      const j1 = Math.min(srcNy - 1, j0 + 1);
      const tx = fx - i0;
      const ty = fy - j0;

      const row0 = j0 * srcNx;
      const row1 = j1 * srcNx;
      const u00 = srcU[row0 + i0]!;
      const u10 = srcU[row0 + i1]!;
      const u01 = srcU[row1 + i0]!;
      const u11 = srcU[row1 + i1]!;
      const v00 = srcV[row0 + i0]!;
      const v10 = srcV[row0 + i1]!;
      const v01 = srcV[row1 + i0]!;
      const v11 = srcV[row1 + i1]!;

      const uTop = u00 * (1 - tx) + u10 * tx;
      const uBot = u01 * (1 - tx) + u11 * tx;
      const uGrid = uTop * (1 - ty) + uBot * ty;

      const vTop = v00 * (1 - tx) + v10 * tx;
      const vBot = v01 * (1 - tx) + v11 * tx;
      const vGrid = vTop * (1 - ty) + vBot * ty;

      // Grid-relative → true-north rotation. γ is the angle between LCC
      // grid-north and true north at this point. For LCC,
      //     γ = n · (λ − λ₀)
      // where λ₀ is the projection orientation longitude and n is the cone
      // constant. We have to wrap (λ − λ₀) into [-π, π] first so that
      // crossing the antimeridian doesn't smear γ into nonsense.
      const lonRad = lon * DEG;
      const gamma = n * wrapPi(lonRad - lambda0);
      const cosG = Math.cos(gamma);
      const sinG = Math.sin(gamma);
      const uTrue = uGrid * cosG + vGrid * sinG;
      const vTrue = -uGrid * sinG + vGrid * cosG;

      uOut[outIdx] = uTrue;
      vOut[outIdx] = vTrue;

      const speed = Math.hypot(uTrue, vTrue);
      if (speed > maxSpeed && Number.isFinite(speed)) maxSpeed = speed;
    }
  }

  const refTime = options.refTime ?? new Date().toISOString();
  const forecastTime = options.forecastTime ?? 0;

  // windy.js rejects anything but template 0 (regular lat/lon); it also
  // divides `(φ0 − φ)` by Δφ with the sign inferred from scanMode. With
  // scanMode = 0, bit 2 is clear → windy negates Δφ internally so that
  // moving south (lat decreasing) corresponds to j increasing, which is
  // exactly how we've laid out the rows above.
  const baseHeader = {
    lo1,
    la1,
    dx,
    dy,
    nx: targetNx,
    ny: targetNy,
    refTime,
    forecastTime,
    scanMode: 0,
  };

  const components: [WindyComponent, WindyComponent] = [
    {
      header: { ...baseHeader, parameterCategory: 2, parameterNumber: 2 }, // UGRD
      data: uOut,
    },
    {
      header: { ...baseHeader, parameterCategory: 2, parameterNumber: 3 }, // VGRD
      data: vOut,
    },
  ];

  return {
    components,
    maxSpeed,
    bounds,
  };
}

/**
 * Sample HRRR LCC wind at regular lat/lon grid points with caller-supplied bounds.
 * Returns true-north u/v components on the target grid.
 * Used to resample HRRR onto an OFS grid for layer combination.
 */
export function sampleHrrrAtLatLon(
  u: DecodedField,
  v: DecodedField,
  grid: LambertConformalGrid,
  targetNx: number,
  targetNy: number,
  bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number },
): { u: Float32Array; v: Float32Array } {
  const srcNx = u.nx;
  const lcc = computeLccUniforms(grid);
  const srcU = u.values;
  const srcV = v.values;
  const n = lcc.n;
  const lambda0 = lcc.lambda0;

  const dx = (bounds.lonMax - bounds.lonMin) / (targetNx - 1);
  const dy = (bounds.latMax - bounds.latMin) / (targetNy - 1);

  const uOut = new Float32Array(targetNx * targetNy);
  const vOut = new Float32Array(targetNx * targetNy);

  for (let j = 0; j < targetNy; j++) {
    // Row 0 = south (matching OFS scan order)
    const lat = bounds.latMin + j * dy;
    for (let i = 0; i < targetNx; i++) {
      const lon = bounds.lonMin + i * dx;
      const idx = j * targetNx + i;

      const { u: gu, v: gv } = lonLatToGridUV(lcc, lon, lat);
      if (gu < 0 || gu > 1 || gv < 0 || gv > 1) {
        uOut[idx] = NaN;
        vOut[idx] = NaN;
        continue;
      }

      const fx = gu * (srcNx - 1);
      const fy = gv * (u.ny - 1);
      const i0 = Math.floor(fx);
      const j0 = Math.floor(fy);
      const i1 = Math.min(srcNx - 1, i0 + 1);
      const j1 = Math.min(u.ny - 1, j0 + 1);
      const tx = fx - i0;
      const ty = fy - j0;

      const row0 = j0 * srcNx;
      const row1 = j1 * srcNx;
      const uGrid = (srcU[row0 + i0]! * (1 - tx) + srcU[row0 + i1]! * tx) * (1 - ty)
                   + (srcU[row1 + i0]! * (1 - tx) + srcU[row1 + i1]! * tx) * ty;
      const vGrid = (srcV[row0 + i0]! * (1 - tx) + srcV[row0 + i1]! * tx) * (1 - ty)
                   + (srcV[row1 + i0]! * (1 - tx) + srcV[row1 + i1]! * tx) * ty;

      // Rotate grid-relative → true-north
      const gamma = n * wrapPi(lon * DEG - lambda0);
      const cosG = Math.cos(gamma);
      const sinG = Math.sin(gamma);
      uOut[idx] = uGrid * cosG + vGrid * sinG;
      vOut[idx] = -uGrid * sinG + vGrid * cosG;
    }
  }

  return { u: uOut, v: vOut };
}
