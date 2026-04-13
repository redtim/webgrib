/**
 * SFBOFS (San Francisco Bay Operational Forecast System) data access.
 *
 * Fetches surface ocean current data via OPeNDAP from the NOAA CO-OPS
 * THREDDS server. In development, requests go through Vite's proxy
 * (/ofs-proxy) to bypass CORS. In production, a server-side proxy is needed.
 *
 * Data source: FVCOM-based ROMS model, regulargrid output interpolated to
 * a 329×553 regular lat/lon grid.
 *
 * Cycles: 03z, 09z, 15z, 21z (4 per day)
 * Forecast range: 48 hours (f000–f048)
 * Nowcast range: 6 hours (n000–n006)
 */

import { parseDap2 } from './dap2.js';

export interface OfsCurrentField {
  u: Float32Array;
  v: Float32Array;
  lat: Float32Array;
  lon: Float32Array;
  nx: number;
  ny: number;
  /** Bounding box in degrees. */
  bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number };
}

/** Available SFBOFS forecast cycles (UTC hours). */
export const SFBOFS_CYCLES = [3, 9, 15, 21] as const;

/** Maximum forecast hours. */
export const SFBOFS_MAX_FHOUR = 48;

// The regulargrid files have these dimensions (from the DDS):
// time = 1, s_rho = 21 (depth levels), eta_rho = 329 (ny), xi_rho = 553 (nx)
// We only want the surface level: s_rho index 20 (top layer in ROMS convention).
const SURFACE_LEVEL = 20; // 0-indexed, top of water column

/**
 * Build the OPeNDAP URL for a SFBOFS regulargrid file with variable subsetting.
 * Only fetches surface-level u/v + coordinate arrays (~1.5 MB total).
 */
function opendapUrl(cycle: number, date: string, fhour: number): string {
  const cc = String(cycle).padStart(2, '0');
  const fhhh = String(fhour).padStart(3, '0');
  const base = `/ofs-proxy/thredds/dodsC/NOAA/SFBOFS/MODELS/${date}/nos.sfbofs.regulargrid.t${cc}z.${date}.fields.f${fhhh}.nc`;

  // OPeNDAP constraint expression: surface level only for u/v, full 2D for lat/lon
  const constraints = [
    `u_eastward[0:0][${SURFACE_LEVEL}:${SURFACE_LEVEL}][0:328][0:552]`,
    `v_northward[0:0][${SURFACE_LEVEL}:${SURFACE_LEVEL}][0:328][0:552]`,
    `Latitude[0:328][0:552]`,
    `Longitude[0:328][0:552]`,
  ].join(',');

  return `${base}.dods?${constraints}`;
}

/**
 * Format a Date as YYYYMMDD string.
 */
export function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${dd}`;
}

/**
 * Get the most recent available SFBOFS cycle for a given time.
 */
export function latestCycle(now: Date = new Date()): { cycle: typeof SFBOFS_CYCLES[number]; date: string } {
  const utcHour = now.getUTCHours();
  // Cycles are available ~4-5 hours after their nominal time
  const availableHour = utcHour - 5;
  let cycle: typeof SFBOFS_CYCLES[number] = SFBOFS_CYCLES[0]!;
  for (const c of SFBOFS_CYCLES) {
    if (c <= availableHour) cycle = c;
  }
  // If no cycle is available today, use yesterday's last cycle
  if (availableHour < SFBOFS_CYCLES[0]!) {
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return { cycle: SFBOFS_CYCLES[SFBOFS_CYCLES.length - 1]!, date: formatDate(yesterday) };
  }
  return { cycle, date: formatDate(now) };
}

/**
 * Fetch surface current data for a specific SFBOFS forecast step.
 */
export async function fetchSfbofsSurface(
  cycle: number,
  date: string,
  fhour: number,
): Promise<OfsCurrentField> {
  const url = opendapUrl(cycle, date, fhour);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`SFBOFS fetch failed: ${resp.status} ${resp.statusText}`);
  const buffer = await resp.arrayBuffer();

  const vars = parseDap2(buffer, ['u_eastward', 'v_northward', 'Latitude', 'Longitude']);
  const uVar = vars.get('u_eastward')!;
  const vVar = vars.get('v_northward')!;
  const latVar = vars.get('Latitude')!;
  const lonVar = vars.get('Longitude')!;

  const ny = latVar.shape[0]!;
  const nx = latVar.shape[1]!;

  // Compute bounds from coordinate arrays
  let lonMin = Infinity, lonMax = -Infinity;
  let latMin = Infinity, latMax = -Infinity;
  for (let i = 0; i < latVar.data.length; i++) {
    const la = latVar.data[i]!;
    const lo = lonVar.data[i]!;
    if (Number.isFinite(la) && la !== 0) {
      if (la < latMin) latMin = la;
      if (la > latMax) latMax = la;
    }
    if (Number.isFinite(lo) && lo !== 0) {
      if (lo < lonMin) lonMin = lo;
      if (lo > lonMax) lonMax = lo;
    }
  }

  // Replace fill values (typically 1e37 or similar) with NaN
  const u = new Float32Array(uVar.data.length);
  const v = new Float32Array(vVar.data.length);
  for (let i = 0; i < u.length; i++) {
    u[i] = Math.abs(uVar.data[i]!) > 1e10 ? NaN : uVar.data[i]!;
    v[i] = Math.abs(vVar.data[i]!) > 1e10 ? NaN : vVar.data[i]!;
  }

  return { u, v, lat: latVar.data, lon: lonVar.data, nx, ny, bounds: { lonMin, lonMax, latMin, latMax } };
}
