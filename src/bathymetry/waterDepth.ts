/**
 * Live water-depth field: SF Bay bathymetry (NAVD88) + SFBOFS zeta (MSL).
 *
 *   depth(x, y, t) = zeta(t) − (elev_navd88(x, y) + NAVD88→MSL)
 *
 * Positive = submerged. Non-positive cells are masked to NaN so the renderer
 * draws them transparent (land / dry). The output lives on the bathymetry
 * grid (~250 m) since it's denser than the OFS grid (~1 km in the bay).
 */
import type { OfsScalarField } from '../ofs/sfbofs.js';
import { fetchSfBayBathymetry, NAVD88_TO_MSL_M, type BathymetryGrid } from './sfbay.js';

export interface WaterDepthField {
  /** Water depth in meters, NaN where dry/land/no-data. */
  values: Float32Array;
  nx: number;
  ny: number;
  bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number };
  /** Finite-value min/max, useful for auto-ranging. */
  min: number;
  max: number;
}

/**
 * Bilinearly sample a regular lat/lon field at a single (lat, lon) point.
 * Returns NaN if the point is outside the field or lands in a NaN cell.
 *
 * The OFS regular grid is a uniform lat/lon grid so we can compute indices
 * analytically from the bounds.
 */
function sampleBilinear(
  values: Float32Array,
  nx: number,
  ny: number,
  bounds: OfsScalarField['bounds'],
  lat: number,
  lon: number,
): number {
  if (lat < bounds.latMin || lat > bounds.latMax) return NaN;
  if (lon < bounds.lonMin || lon > bounds.lonMax) return NaN;

  const fx = ((lon - bounds.lonMin) / (bounds.lonMax - bounds.lonMin)) * (nx - 1);
  const fy = ((lat - bounds.latMin) / (bounds.latMax - bounds.latMin)) * (ny - 1);
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = Math.min(nx - 1, x0 + 1);
  const y1 = Math.min(ny - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;

  const v00 = values[y0 * nx + x0]!;
  const v10 = values[y0 * nx + x1]!;
  const v01 = values[y1 * nx + x0]!;
  const v11 = values[y1 * nx + x1]!;

  // If any corner is NaN, fall back to nearest non-NaN, else NaN.
  const finite = [v00, v10, v01, v11].filter(Number.isFinite);
  if (finite.length === 0) return NaN;
  if (finite.length < 4) return finite[0]!;

  const a = v00 * (1 - tx) + v10 * tx;
  const b = v01 * (1 - tx) + v11 * tx;
  return a * (1 - ty) + b * ty;
}

export async function computeWaterDepth(zeta: OfsScalarField): Promise<WaterDepthField> {
  const bathy = await fetchSfBayBathymetry();
  return composeDepth(bathy, zeta);
}

function composeDepth(bathy: BathymetryGrid, zeta: OfsScalarField): WaterDepthField {
  const { nx, ny, lat, lon, elevation } = bathy;
  const values = new Float32Array(nx * ny);
  let min = Infinity, max = -Infinity;

  for (let j = 0; j < ny; j++) {
    const latJ = lat[j]!;
    for (let i = 0; i < nx; i++) {
      const idx = j * nx + i;
      const elev = elevation[idx]!;
      if (!Number.isFinite(elev)) { values[idx] = NaN; continue; }
      const elevMsl = elev + NAVD88_TO_MSL_M;
      const z = sampleBilinear(zeta.values, zeta.nx, zeta.ny, zeta.bounds, latJ, lon[i]!);
      if (!Number.isFinite(z)) { values[idx] = NaN; continue; }
      const depth = z - elevMsl;
      if (depth <= 0) { values[idx] = NaN; continue; }
      values[idx] = depth;
      if (depth < min) min = depth;
      if (depth > max) max = depth;
    }
  }

  return {
    values, nx, ny,
    bounds: bathy.bounds,
    min: Number.isFinite(min) ? min : 0,
    max: Number.isFinite(max) ? max : 1,
  };
}
