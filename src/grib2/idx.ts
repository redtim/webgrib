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
    throw new Error(`No .idx record matched ${JSON.stringify(query)} (of ${records.length} records)`);
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
export function hrrrUrls(cycle: string, fhour: number, product: 'wrfsfcf' | 'wrfprsf' | 'wrfnatf' | 'wrfsubhf' = 'wrfsfcf'): { data: string; idx: string } {
  const yyyy = cycle.slice(0, 4);
  const mm = cycle.slice(4, 6);
  const dd = cycle.slice(6, 8);
  const hh = cycle.slice(8, 10);
  const fh = String(fhour).padStart(2, '0');
  const base = `https://noaa-hrrr-bdp-pds.s3.amazonaws.com/hrrr.${yyyy}${mm}${dd}/conus/hrrr.t${hh}z.${product}${fh}.grib2`;
  return { data: base, idx: base + '.idx' };
}
