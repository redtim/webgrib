/**
 * SF Bay bathymetry from NCEI's 1/3 arc-second regional DEM (NAVD88).
 *
 * Source: https://www.ngdc.noaa.gov/thredds/dodsC/regional/san_francisco_13_navd88_2010.nc
 *
 * Grid layout (full file): lat=12529 × lon=15661, ~10 m resolution.
 *   lat ascends south→north from 37.32 to 38.48
 *   lon ascends west→east from -123.30 to -121.85
 *
 * Band1 is bed elevation in meters relative to NAVD88, positive up.
 * Values below zero are underwater; fill is -9999.
 *
 * We subset to the Bay and stride by 27 for ~250 m effective resolution
 * (~460 KB over the wire). The result is cached in-memory for the session —
 * bathymetry is static.
 *
 * NAVD88 ↔ SFBOFS MSL: near Golden Gate NAVD88 ≈ MSL − 0.035 m, so a constant
 * offset is sufficient for v1. Refine per-tile later if needed.
 */
import { parseDap2 } from '../ofs/dap2.js';

const DEM_URL =
  'https://www.ngdc.noaa.gov/thredds/dodsC/regional/san_francisco_13_navd88_2010.nc';

// File pixel spacing in degrees (1/3 arc-second).
const DEG_PER_PX = 0.00009259259;
const FILE_LAT0 = 37.32;
const FILE_LON0 = -123.30;
const FILE_NLAT = 12529;
const FILE_NLON = 15661;

// SF Bay subset bbox.
const BBOX_LAT_MIN = 37.40;
const BBOX_LAT_MAX = 38.30;
const BBOX_LON_MIN = -122.80;
const BBOX_LON_MAX = -122.00;

// Stride along each axis (~250 m at these latitudes).
const STRIDE = 27;

const FILL_THRESH = 9000;

/**
 * Offset to add to a NAVD88 elevation to express it relative to local MSL.
 * Near Golden Gate NAVD88 ≈ MSL − 0.035 m, so an elevation E above NAVD88 is
 * (E − 0.035) above MSL. Hence NAVD88→MSL offset is -0.035 m.
 */
export const NAVD88_TO_MSL_M = -0.035;

export interface BathymetryGrid {
  /** Bed elevation in meters, NAVD88, positive up. NaN where no data. */
  elevation: Float32Array;
  lat: Float32Array;
  lon: Float32Array;
  nx: number;
  ny: number;
  bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number };
}

let cached: BathymetryGrid | null = null;
let inflight: Promise<BathymetryGrid> | null = null;

function clampIndex(v: number, max: number): number {
  return Math.max(0, Math.min(max, Math.round(v)));
}

function buildUrl(): string {
  const iLat0 = clampIndex((BBOX_LAT_MIN - FILE_LAT0) / DEG_PER_PX, FILE_NLAT - 1);
  const iLat1 = clampIndex((BBOX_LAT_MAX - FILE_LAT0) / DEG_PER_PX, FILE_NLAT - 1);
  const iLon0 = clampIndex((BBOX_LON_MIN - FILE_LON0) / DEG_PER_PX, FILE_NLON - 1);
  const iLon1 = clampIndex((BBOX_LON_MAX - FILE_LON0) / DEG_PER_PX, FILE_NLON - 1);

  // Single Grid request returns Band1 ARRAY + MAPS (lat, lon) in DDS order.
  const ce = `Band1[${iLat0}:${STRIDE}:${iLat1}][${iLon0}:${STRIDE}:${iLon1}]`
    .replace(/\[/g, '%5B')
    .replace(/\]/g, '%5D');
  return `${DEM_URL}.dods?${ce}`;
}

/** Fetch (and cache) the SF Bay bathymetry grid. */
export async function fetchSfBayBathymetry(): Promise<BathymetryGrid> {
  if (cached) return cached;
  if (inflight) return inflight;

  inflight = (async () => {
    const resp = await fetch(buildUrl());
    if (!resp.ok) throw new Error(`CUDEM fetch failed: ${resp.status} ${resp.statusText}`);
    const buf = await resp.arrayBuffer();

    const vars = parseDap2(buf, ['Band1', 'lat', 'lon']);
    const band = vars.get('Band1');
    const latVar = vars.get('lat');
    const lonVar = vars.get('lon');
    if (!band || !latVar || !lonVar) {
      const missing = ['Band1', 'lat', 'lon'].filter((n) => !vars.has(n));
      throw new Error(`CUDEM response missing variables: ${missing.join(', ')}`);
    }

    const ny = band.shape[0]!;
    const nx = band.shape[1]!;
    const elevation = new Float32Array(band.data.length);
    for (let i = 0; i < elevation.length; i++) {
      const e = band.data[i]!;
      elevation[i] = Math.abs(e) > FILL_THRESH ? NaN : e;
    }

    const bounds = {
      latMin: latVar.data[0]!,
      latMax: latVar.data[latVar.data.length - 1]!,
      lonMin: lonVar.data[0]!,
      lonMax: lonVar.data[lonVar.data.length - 1]!,
    };

    cached = { elevation, lat: latVar.data, lon: lonVar.data, nx, ny, bounds };
    return cached;
  })();

  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}
