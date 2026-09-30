/**
 * NOAA .idx sidecar parser + HTTP Range streamer.
 *
 * Every GRIB2 file NOAA publishes has a companion text file with one line
 * per message:
 *
 *   recordNumber:byteOffset:dateSpec:parameterShortName:levelDesc:forecastSpec:
 *
 * Example (HRRR):
 *
 *   1:0:d=2026041112:REFC:entire atmosphere:anl:
 *   2:63912:d=2026041112:RETOP:cloud top:anl:
 *   3:91024:d=2026041112:VIS:surface:anl:
 *   ...
 *
 * Given (parameter, level, forecast) we can resolve a single byte range
 * `[offset, nextOffset - 1]` and fetch just that slice with an HTTP Range
 * header, typically ~200–800 KB instead of hundreds of MB.
 */

export interface IdxRecord {
  recordNumber: number;
  byteOffset: number;
  dateSpec: string;
  parameter: string;
  level: string;
  forecast: string;
  /** Raw unparsed line, in case the caller wants to filter on custom fields. */
  raw: string;
}

export interface IdxResolved extends IdxRecord {
  /** End byte (inclusive) of this record's message, computed from the next record. */
  byteLengthOrUndefined: number | undefined;
}

export function parseIdx(text: string): IdxRecord[] {
  const out: IdxRecord[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(':');
    if (parts.length < 6) continue;
    out.push({
      recordNumber: Number(parts[0]),
      byteOffset: Number(parts[1]),
      dateSpec: parts[2]!,
      parameter: parts[3]!,
      level: parts[4]!,
      forecast: parts[5]!,
      raw: line,
    });
  }
  return out;
}

export interface IdxQuery {
  parameter?: string | RegExp;
  level?: string | RegExp;
  forecast?: string | RegExp;
}

export function findRecord(records: IdxRecord[], q: IdxQuery): IdxResolved | null {
  const match = (value: string, pattern: string | RegExp | undefined): boolean => {
    if (pattern === undefined) return true;
    if (typeof pattern === 'string') return value === pattern;
    return pattern.test(value);
  };
  for (let i = 0; i < records.length; i++) {
    const r = records[i]!;
    if (match(r.parameter, q.parameter) && match(r.level, q.level) && match(r.forecast, q.forecast)) {
      const next = records[i + 1];
      return { ...r, byteLengthOrUndefined: next ? next.byteOffset - r.byteOffset : undefined };
    }
  }
  return null;
}

export interface FetchOptions {
  signal?: AbortSignal;
  /** Map an .idx URL to its corresponding .grib2 data URL. Defaults to stripping ".idx". */
  dataUrlFor?: (idxUrl: string) => string;
  /** Extra headers to attach to both requests. */
  headers?: Record<string, string>;
}

export async function fetchIdx(idxUrl: string, opts: FetchOptions = {}): Promise<IdxRecord[]> {
  const res = await fetch(idxUrl, { signal: opts.signal, headers: opts.headers });
  if (!res.ok) throw new Error(`Failed to fetch idx ${idxUrl}: ${res.status}`);
  return parseIdx(await res.text());
}

/**
 * Fetch a specific message by querying the .idx, resolving to a byte range,
 * and issuing an HTTP Range request for just that slice.
 *
 * Returns the raw GRIB2 bytes (one complete message). If `byteLengthOrUndefined`
 * is null (i.e., the matched record is the last in the file), we send a
 * Range with an open-ended upper bound, which NOAA's S3 supports.
 */
export async function fetchMessageBytes(
  idxUrl: string,
  query: IdxQuery,
  opts: FetchOptions = {},
): Promise<{ bytes: Uint8Array; record: IdxResolved }> {
  const records = await fetchIdx(idxUrl, opts);
  const hit = findRecord(records, query);
  if (!hit) {
    throw new Error(`No .idx record matched ${JSON.stringify(query, (_k, v) => v instanceof RegExp ? v.source : v)} (of ${records.length} records)`);
  }
  const dataUrl = (opts.dataUrlFor ?? ((u) => u.replace(/\.idx$/, '')))(idxUrl);
  const start = hit.byteOffset;
  const end = hit.byteLengthOrUndefined != null ? start + hit.byteLengthOrUndefined - 1 : '';
  const range = `bytes=${start}-${end}`;
  const res = await fetch(dataUrl, {
    signal: opts.signal,
    headers: { Range: range, ...(opts.headers ?? {}) },
  });
  if (!res.ok && res.status !== 206) {
    throw new Error(`Range fetch failed: ${res.status} ${res.statusText}`);
  }
  const buf = await res.arrayBuffer();
  return { bytes: new Uint8Array(buf), record: hit };
}

/**
 * Convenience builder for NOAA HRRR on the S3 Open Data bucket.
 *
 *   https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.YYYYMMDD/conus/hrrr.tHHz.wrfsfcfFF.grib2
 *
 * cycle = "YYYYMMDDHH"; fhour is the forecast hour (0..48 depending on cycle).
 */
/**
 * Build a forecast-time regex for .idx matching.
 * fhour 0 → /^anl$/, fhour N → /^N hour fcst$/
 */
export function forecastQuery(fhour: number): RegExp {
  return fhour === 0 ? /^anl$/ : new RegExp(`^${fhour} hour fcst$`);
}

/** Forecast regex for 1-hour accumulated fields (APCP, etc.). */
export function accForecastQuery(fhour: number): RegExp {
  if (fhour <= 0) return /^0-0 day acc fcst$/;
  if (fhour === 1) return /^0-1 hour acc fcst$/;
  return new RegExp(`^${fhour - 1}-${fhour} hour acc fcst$`);
}

export function hrrrUrls(cycle: string, fhour: number, product: 'wrfsfcf' | 'wrfprsf' | 'wrfnatf' | 'wrfsubhf' = 'wrfsfcf'): { data: string; idx: string } {
  const yyyy = cycle.slice(0, 4);
  const mm = cycle.slice(4, 6);
  const dd = cycle.slice(6, 8);
  const hh = cycle.slice(8, 10);
  const fh = String(fhour).padStart(2, '0');
  const base = `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${yyyy}${mm}${dd}/conus/hrrr.t${hh}z.${product}${fh}.grib2`;
  return { data: base, idx: base + '.idx' };
}

/**
 * RRFS (Rapid Refresh Forecast System) deterministic CONUS output on NOMADS.
 *
 *   {base}/rrfs.YYYYMMDD/HH/rrfs.tHHz.{2dfld|prslev}.3km.fFFF.conus.grib2
 *
 * The CONUS subset is on the same 3 km Lambert Conformal grid as HRRR
 * (1799×1059), so everything downstream of the decoder is shared. Surface
 * and single-level fields live in `2dfld`; isobaric levels live in `prslev`.
 *
 * NOMADS sends no CORS headers, so requests go through the same proxy as OFS
 * (Vite dev proxy locally, Cloudflare Worker in production).
 *
 * RRFS became operational on 2026-10-14 (SCN 26-48); before that only the
 * parallel feed under `rrfs/para` exists. Flip RRFS_STREAM to 'prod' once the
 * `rrfs/prod` directory is populated.
 */
export type RrfsProduct = '2dfld' | 'prslev';

const RRFS_STREAM: 'para' | 'prod' = 'para';
const NOMADS_PROXY: string =
  (import.meta.env?.VITE_OFS_PROXY_URL as string | undefined) ?? '/ofs-proxy';

export function rrfsUrls(cycle: string, fhour: number, product: RrfsProduct = '2dfld'): { data: string; idx: string } {
  const hh = cycle.slice(8, 10);
  const fh = String(fhour).padStart(3, '0');
  const base = `${NOMADS_PROXY}/nomads/pub/data/nccf/com/rrfs/${RRFS_STREAM}/rrfs.${cycle.slice(0, 8)}/${hh}/rrfs.t${hh}z.${product}.3km.f${fh}.conus.grib2`;
  return { data: base, idx: base + '.idx' };
}

/** Max forecast hour for an RRFS cycle: 84 h at 00/06/12/18z, 18 h otherwise. */
export function rrfsMaxFhour(cycle: string): number {
  return Number(cycle.slice(8, 10)) % 6 === 0 ? 84 : 18;
}

/**
 * Build URLs for GEFS ensemble member files on NOMADS.
 *
 * member 0 = control (gec00), 1-30 = perturbation (gep01-gep30).
 * Uses the 0.5° "a" product (pgrb2ap5) which has the most common fields.
 */
export function gefsUrls(cycle: string, fhour: number, member: number): { data: string; idx: string } {
  const fh = String(fhour).padStart(3, '0');
  const hh = cycle.slice(8, 10);
  const prefix = member === 0 ? 'gec00' : `gep${String(member).padStart(2, '0')}`;
  const base = `https://noaa-gefs-pds.s3.amazonaws.com/gefs.${cycle.slice(0, 8)}/${hh}/atmos/pgrb2ap5/${prefix}.t${hh}z.pgrb2a.0p50.f${fh}`;
  return { data: base, idx: base + '.idx' };
}

/** URL for the pre-computed ensemble mean (geavg) or spread (gespr) file. */
export function gefsStatsUrls(cycle: string, fhour: number, stat: 'mean' | 'spread'): { data: string; idx: string } {
  const fh = String(fhour).padStart(3, '0');
  const hh = cycle.slice(8, 10);
  const prefix = stat === 'mean' ? 'geavg' : 'gespr';
  const base = `https://noaa-gefs-pds.s3.amazonaws.com/gefs.${cycle.slice(0, 8)}/${hh}/atmos/pgrb2ap5/${prefix}.t${hh}z.pgrb2a.0p50.f${fh}`;
  return { data: base, idx: base + '.idx' };
}

/**
 * Recent GEFS cycles. GEFS runs every 6 hours (00/06/12/18z).
 * Applies a production delay to avoid requesting cycles that aren't published yet.
 */
export function gefsRecentCycles(count: number, productionDelayHours = 7): string[] {
  const now = new Date(Date.now() - productionDelayHours * 3600 * 1000);
  // Round down to the nearest 6-hour cycle
  const cycleHour = Math.floor(now.getUTCHours() / 6) * 6;
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cycleHour));
  const cycles: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base.getTime() - i * 6 * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    cycles.push(`${y}${m}${day}${h}`);
  }
  return cycles;
}

/** Valid GEFS forecast hours — 3-hourly to 240h, then 12-hourly to 384h. */
export const GEFS_FHOURS: number[] = (() => {
  const hours: number[] = [];
  for (let h = 0; h <= 240; h += 3) hours.push(h);
  for (let h = 246; h <= 384; h += 6) hours.push(h);
  return hours;
})();
