/**
 * SFBOFS (San Francisco Bay Operational Forecast System) data access.
 *
 * Two data backends with automatic fallback:
 *   1. S3 range requests — fetches surface-level data directly from NOAA's S3
 *      bucket using fixed byte offsets into the regulargrid NetCDF4/HDF5 files.
 *   2. OPeNDAP/THREDDS — subsetting via the NOAA CO-OPS THREDDS server.
 *
 * Both go through the OFS proxy (Vite dev proxy or Cloudflare Worker) for CORS.
 *
 * Data source: FVCOM-based ROMS model, regulargrid output interpolated to
 * a 329×553 regular lat/lon grid.
 *
 * Cycles: 03z, 09z, 15z, 21z (4 per day)
 * Forecast range: 48 hours (f000–f048)
 * Nowcast range: 6 hours (n000–n006)
 */

import { parseDap2 } from './dap2.js';

/**
 * OFS proxy base URL.
 * - Dev: Vite proxy at /ofs-proxy rewrites to the correct upstream
 * - Prod: Cloudflare Worker at the configured URL
 *
 * Set VITE_OFS_PROXY_URL in .env.production to your deployed worker URL,
 * e.g. https://ofs-proxy.yourname.workers.dev
 */
const OFS_PROXY = import.meta.env.VITE_OFS_PROXY_URL as string | undefined ?? '/ofs-proxy';

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
// time = 1, Depth = 21 (0m..100m), ny = 329, nx = 553
// Surface is depth index 0 (0 meters).
const NX = 553;
const NY = 329;
const SURFACE_LEVEL = 0;

// ---------------------------------------------------------------------------
// S3 range-request constants
//
// Every SFBOFS regulargrid NetCDF4/HDF5 file has identical internal layout
// (verified across dates, cycles, and forecast hours — all files are exactly
// 71,702,783 bytes). The byte offsets below point to the raw float32/float64
// arrays stored contiguously inside the HDF5 chunked datasets.
//
// Lat/Lon are contiguous Float64 arrays (329×553).
// u_eastward/v_northward are chunked (1,11,165,277) Float32LE with no
// compression. The 4 surface-depth chunks (depth index 0) for each variable
// are stored contiguously.
// ---------------------------------------------------------------------------

/**
 * Lat/Lon arrays are stored contiguously as Float64LE, 329×553 each.
 * We fetch them as a single range request.
 */
const LATLON_OFFSET = 42933;
const LATLON_LENGTH = 2 * NY * NX * 8; // 2,910,992 bytes (Lat + Lon back-to-back)

/**
 * Surface chunk byte offsets for u_eastward and v_northward.
 *
 * Each chunk is (1, 11, 165, 277) float32 = 2,011,020 bytes, but we only
 * need depth index 0 — the first 165×277×4 = 182,820 bytes of each chunk.
 * We fetch 4 small range requests per variable instead of the full chunks.
 *
 * Total transfer: 8 × 179 KB = ~1.4 MB (comparable to OPeNDAP).
 */

/** Surface slice size: first depth level of one chunk. */
const CHUNK_SURFACE_BYTES = 165 * 277 * 4; // 182,820 bytes
/** Chunk tile dimensions — the last tiles are slightly smaller. */
const TILE_ROWS = [165, 164] as const; // ny chunks: 0..164, 165..328
const TILE_COLS = [277, 276] as const; // nx chunks: 0..276, 277..552

/**
 * Per-chunk info: byte offset of the chunk start in the file, and which
 * grid tile it maps to. Order matches ascending byte offset.
 *
 *   chunk 0: offset 5879557  → ny=0..164,   nx=277..552
 *   chunk 1: offset 7890577  → ny=0..164,   nx=0..276
 *   chunk 2: offset 9901597  → ny=165..328,  nx=0..276
 *   chunk 3: offset 11912617 → ny=165..328,  nx=277..552
 */
const U_CHUNKS = [
  { offset: 5879557,  yChunk: 0, xChunk: 1 },
  { offset: 7890577,  yChunk: 0, xChunk: 0 },
  { offset: 9901597,  yChunk: 1, xChunk: 0 },
  { offset: 11912617, yChunk: 1, xChunk: 1 },
] as const;

const V_CHUNKS = [
  { offset: 17949333, yChunk: 0, xChunk: 1 },
  { offset: 19960353, yChunk: 0, xChunk: 0 },
  { offset: 21971373, yChunk: 1, xChunk: 0 },
  { offset: 23982393, yChunk: 1, xChunk: 1 },
] as const;

// Cached coordinate arrays — they never change between files.
let cachedLat: Float32Array | null = null;
let cachedLon: Float32Array | null = null;
let cachedBounds: OfsCurrentField['bounds'] | null = null;

// ---------------------------------------------------------------------------
// OPeNDAP (THREDDS) accessor
// ---------------------------------------------------------------------------

/**
 * Build the OPeNDAP URL for a SFBOFS regulargrid file with variable subsetting.
 * Only fetches surface-level u/v + coordinate arrays (~1.5 MB total).
 */
function opendapUrl(cycle: number, date: string, fhour: number): string {
  const cc = String(cycle).padStart(2, '0');
  const fhhh = String(fhour).padStart(3, '0');
  // Date format in path: YYYY/MM/DD
  const datePath = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`;
  const base = `${OFS_PROXY}/thredds/dodsC/NOAA/SFBOFS/MODELS/${datePath}/sfbofs.t${cc}z.${date}.regulargrid.f${fhhh}.nc`;

  // OPeNDAP constraint expression: surface level only for u/v, full 2D for lat/lon.
  // Brackets must be percent-encoded — THREDDS returns 400 on raw brackets.
  const ce = [
    `u_eastward[0:0][${SURFACE_LEVEL}:${SURFACE_LEVEL}][0:328][0:552]`,
    `v_northward[0:0][${SURFACE_LEVEL}:${SURFACE_LEVEL}][0:328][0:552]`,
    `Latitude[0:328][0:552]`,
    `Longitude[0:328][0:552]`,
  ].join(',').replace(/\[/g, '%5B').replace(/\]/g, '%5D');

  return `${base}.dods?${ce}`;
}

async function fetchViaThredds(cycle: number, date: string, fhour: number): Promise<OfsCurrentField> {
  const url = opendapUrl(cycle, date, fhour);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`SFBOFS THREDDS fetch failed: ${resp.status} ${resp.statusText}`);
  const buffer = await resp.arrayBuffer();

  const vars = parseDap2(buffer, ['u_eastward', 'v_northward', 'Latitude', 'Longitude']);
  const uVar = vars.get('u_eastward');
  const vVar = vars.get('v_northward');
  const latVar = vars.get('Latitude');
  const lonVar = vars.get('Longitude');
  if (!uVar || !vVar || !latVar || !lonVar) {
    const missing = ['u_eastward', 'v_northward', 'Latitude', 'Longitude'].filter((n) => !vars.has(n));
    throw new Error(`SFBOFS response missing variables: ${missing.join(', ')}`);
  }

  const ny = latVar.shape[0]!;
  const nx = latVar.shape[1]!;
  const bounds = computeBounds(latVar.data, lonVar.data);
  const { u, v } = cleanFillValues(uVar.data, vVar.data);

  return { u, v, lat: latVar.data, lon: lonVar.data, nx, ny, bounds };
}

// ---------------------------------------------------------------------------
// S3 range-request accessor
// ---------------------------------------------------------------------------

/** Build the S3 path for a regulargrid file. */
function s3Path(cycle: number, date: string, fhour: number): string {
  const cc = String(cycle).padStart(2, '0');
  const fhhh = String(fhour).padStart(3, '0');
  const datePath = `${date.slice(0, 4)}/${date.slice(4, 6)}/${date.slice(6, 8)}`;
  return `${OFS_PROXY}/s3/sfbofs/netcdf/${datePath}/sfbofs.t${cc}z.${date}.regulargrid.f${fhhh}.nc`;
}

/** Fetch a byte range from the proxy and return the ArrayBuffer. */
async function fetchRange(url: string, offset: number, length: number): Promise<ArrayBuffer> {
  const resp = await fetch(url, {
    headers: { Range: `bytes=${offset}-${offset + length - 1}` },
  });
  if (!resp.ok && resp.status !== 206) {
    throw new Error(`S3 range fetch failed: ${resp.status} ${resp.statusText}`);
  }
  return resp.arrayBuffer();
}

/**
 * Reassemble a 329×553 surface grid from 4 chunk surface-slice buffers.
 *
 * Each buffer contains only the surface layer (depth=0) of one chunk:
 * 165×277 floats in C order (row-major). HDF5 always writes full chunk
 * dimensions, so edge chunks have padding that we skip.
 */
function assembleSurface(
  tiles: Array<{ buf: ArrayBuffer; yChunk: number; xChunk: number }>,
): Float32Array {
  const grid = new Float32Array(NY * NX);

  for (const { buf, yChunk, xChunk } of tiles) {
    const view = new DataView(buf);
    const yStart = yChunk === 0 ? 0 : 165;
    const xStart = xChunk === 0 ? 0 : 277;
    const rows = TILE_ROWS[yChunk]!;
    const cols = TILE_COLS[xChunk]!;
    // Full chunk row width is always 277 floats (the chunk dimension),
    // even for edge chunks where only 276 columns hold real data.
    const chunkCols = 277;

    for (let r = 0; r < rows; r++) {
      const srcOffset = (r * chunkCols) * 4;
      const dstOffset = (yStart + r) * NX + xStart;
      for (let c = 0; c < cols; c++) {
        grid[dstOffset + c] = view.getFloat32(srcOffset + c * 4, true); // little-endian
      }
    }
  }

  return grid;
}

/** Fetch and cache the Lat/Lon coordinate arrays from S3 (single range request). */
async function ensureCoordinates(baseUrl: string): Promise<void> {
  if (cachedLat && cachedLon && cachedBounds) return;

  const buf = await fetchRange(baseUrl, LATLON_OFFSET, LATLON_LENGTH);

  // Lat and Lon are stored back-to-back as Float64LE, 329×553 each.
  const n = NY * NX;
  const all64 = new Float64Array(buf);
  cachedLat = new Float32Array(n);
  cachedLon = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    cachedLat[i] = all64[i]!;
    cachedLon[i] = all64[n + i]!;
  }

  cachedBounds = computeBounds(cachedLat, cachedLon);
}

async function fetchViaS3(cycle: number, date: string, fhour: number): Promise<OfsCurrentField> {
  const baseUrl = s3Path(cycle, date, fhour);

  // Fetch coordinates (cached) and all 8 surface tile slices in parallel.
  // Each tile fetch is only ~179 KB — total ~1.4 MB for u+v.
  const fetches = [
    ensureCoordinates(baseUrl),
    ...U_CHUNKS.map((c) => fetchRange(baseUrl, c.offset, CHUNK_SURFACE_BYTES)),
    ...V_CHUNKS.map((c) => fetchRange(baseUrl, c.offset, CHUNK_SURFACE_BYTES)),
  ] as const;

  const results = await Promise.all(fetches);

  // results[0] is void (coordinates), [1..4] are u tiles, [5..8] are v tiles
  const uTiles = U_CHUNKS.map((c, i) => ({
    buf: results[1 + i] as ArrayBuffer,
    yChunk: c.yChunk,
    xChunk: c.xChunk,
  }));
  const vTiles = V_CHUNKS.map((c, i) => ({
    buf: results[5 + i] as ArrayBuffer,
    yChunk: c.yChunk,
    xChunk: c.xChunk,
  }));

  const uRaw = assembleSurface(uTiles);
  const vRaw = assembleSurface(vTiles);
  const { u, v } = cleanFillValues(uRaw, vRaw);

  return {
    u, v,
    lat: cachedLat!,
    lon: cachedLon!,
    nx: NX, ny: NY,
    bounds: cachedBounds!,
  };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function computeBounds(lat: Float32Array, lon: Float32Array): OfsCurrentField['bounds'] {
  let lonMin = Infinity, lonMax = -Infinity;
  let latMin = Infinity, latMax = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    const la = lat[i]!;
    const lo = lon[i]!;
    if (Number.isFinite(la) && la !== 0) {
      if (la < latMin) latMin = la;
      if (la > latMax) latMax = la;
    }
    if (Number.isFinite(lo) && lo !== 0) {
      if (lo < lonMin) lonMin = lo;
      if (lo > lonMax) lonMax = lo;
    }
  }
  return { lonMin, lonMax, latMin, latMax };
}

/** Replace fill values (-99999 or similar large magnitudes) with NaN. */
function cleanFillValues(
  uRaw: Float32Array,
  vRaw: Float32Array,
): { u: Float32Array; v: Float32Array } {
  const FILL_THRESH = 100;
  const u = new Float32Array(uRaw.length);
  const v = new Float32Array(vRaw.length);
  for (let i = 0; i < u.length; i++) {
    u[i] = Math.abs(uRaw[i]!) > FILL_THRESH ? NaN : uRaw[i]!;
    v[i] = Math.abs(vRaw[i]!) > FILL_THRESH ? NaN : vRaw[i]!;
  }
  return { u, v };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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

// Cache for fetched OFS fields — keyed by "cycle:date:fhour"
const ofsCache = new Map<string, OfsCurrentField>();
const OFS_CACHE_MAX = 20;

/**
 * Fetch surface current data for a specific SFBOFS forecast step.
 * Tries S3 range requests first; falls back to THREDDS/OPeNDAP on failure.
 * Results are cached in memory (up to 20 entries).
 */
export async function fetchSfbofsSurface(
  cycle: number,
  date: string,
  fhour: number,
): Promise<OfsCurrentField> {
  const cacheKey = `${cycle}:${date}:${fhour}`;
  const cached = ofsCache.get(cacheKey);
  if (cached) return cached;

  let result: OfsCurrentField;
  try {
    result = await fetchViaS3(cycle, date, fhour);
  } catch (s3Err) {
    console.warn('SFBOFS S3 fetch failed, falling back to THREDDS:', s3Err);
    result = await fetchViaThredds(cycle, date, fhour);
  }

  // Evict oldest entries if cache is full
  if (ofsCache.size >= OFS_CACHE_MAX) {
    const oldest = ofsCache.keys().next().value!;
    ofsCache.delete(oldest);
  }
  ofsCache.set(cacheKey, result);

  return result;
}
