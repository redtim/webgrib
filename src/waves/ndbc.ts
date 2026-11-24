/**
 * NDBC (National Data Buoy Center) realtime2 spectral wave data access.
 *
 * Each buoy with a directional wave sensor publishes five text files, one
 * row per hour, newest first, about 45 days deep:
 *   <id>.data_spec   energy density E(f), m²/Hz   (has an extra Sep_Freq column)
 *   <id>.swdir       mean direction α1, degrees from
 *   <id>.swdir2      principal direction α2
 *   <id>.swr1        first spreading coefficient r1
 *   <id>.swr2        second spreading coefficient r2
 * Every value is written as "value (freq)" so the bin frequencies travel
 * with the data.
 *
 * NDBC sends no CORS headers, so everything goes through the OFS proxy
 * (Vite dev proxy or the Cloudflare Worker, see worker/ofs-proxy.js). Only
 * the leading bytes of each file are fetched: the files are newest-first,
 * so a 150 KB range is the most recent five days or so.
 *
 * There is no API for "which buoys have spectral data", so the realtime2
 * directory listing is scraped for *.data_spec links, then joined with
 * activestations.xml for names and positions.
 */

import type { SpectrumRecord } from './spectrum.js';

// Guarded so the parser can be unit-tested under node, where import.meta.env is absent.
const OFS_PROXY = (import.meta as { env?: { VITE_OFS_PROXY_URL?: string } }).env?.VITE_OFS_PROXY_URL ?? '/ofs-proxy';
const NDBC = `${OFS_PROXY}/ndbc`;

/** Bytes of each spectral file to fetch. 150 KB ≈ 115 hourly records. */
const SPECTRUM_RANGE_BYTES = 150_000;

export interface WaveStation {
  id: string;
  name: string;
  owner: string;
  lat: number;
  lon: number;
}

export interface StationSpectra {
  station: string;
  /** Oldest first. */
  records: SpectrumRecord[];
}

const SPEC_HREF_RE = /href="([A-Za-z0-9]+)\.data_spec"/g;

/** Buoys that currently publish spectral wave files, with positions. */
export async function fetchWaveStations(signal?: AbortSignal): Promise<WaveStation[]> {
  const [listing, xml] = await Promise.all([
    fetchText(`${NDBC}/data/realtime2/`, signal),
    fetchText(`${NDBC}/activestations.xml`, signal),
  ]);

  const specIds = new Set<string>();
  for (const m of listing.matchAll(SPEC_HREF_RE)) specIds.add(m[1]!.toUpperCase());

  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const stations: WaveStation[] = [];
  for (const st of Array.from(doc.getElementsByTagName('station'))) {
    const id = (st.getAttribute('id') ?? '').trim();
    if (!id || !specIds.has(id.toUpperCase())) continue;
    const lat = Number(st.getAttribute('lat'));
    const lon = Number(st.getAttribute('lon'));
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    stations.push({
      id,
      name: st.getAttribute('name') ?? '',
      owner: st.getAttribute('owner') ?? '',
      lat,
      lon,
    });
  }
  stations.sort((a, b) => a.id.localeCompare(b.id));
  return stations;
}

/** The newest few days of spectra for one buoy, directional moments merged in by timestamp. */
export async function fetchStationSpectra(station: string, signal?: AbortSignal): Promise<StationSpectra> {
  if (!/^[A-Za-z0-9]{1,10}$/.test(station)) throw new Error(`Invalid station id: ${station}`);
  const id = station.toUpperCase();
  const [spec, swdir, swdir2, swr1, swr2] = await Promise.all([
    fetchSpectralFile(id, 'data_spec', signal),
    fetchSpectralFile(id, 'swdir', signal),
    fetchSpectralFile(id, 'swdir2', signal),
    fetchSpectralFile(id, 'swr1', signal),
    fetchSpectralFile(id, 'swr2', signal),
  ]);
  if (spec === null) throw new Error(`No spectral data for station ${id}`);
  return { station: id, records: mergeSpectralFiles(spec, swdir, swdir2, swr1, swr2) };
}

/** Fetches and parses one file; null when the buoy does not publish it. */
async function fetchSpectralFile(id: string, ext: string, signal?: AbortSignal): Promise<ParsedRow[] | null> {
  const resp = await fetch(`${NDBC}/data/realtime2/${id}.${ext}`, {
    headers: { Range: `bytes=0-${SPECTRUM_RANGE_BYTES - 1}` },
    signal,
  });
  if (resp.status === 404) return null;
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${id}.${ext}`);
  // 206 is the range we asked for; 200 means the server sent the whole file.
  return parseSpectralFile(await resp.text(), ext === 'data_spec', resp.status === 206);
}

async function fetchText(url: string, signal?: AbortSignal): Promise<string> {
  const resp = await fetch(url, { signal });
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${url}`);
  return resp.text();
}

// ---------------------------------------------------------------------------
// Parsing — exported for tests
// ---------------------------------------------------------------------------

export interface ParsedRow {
  time: string;
  freqs: number[];
  values: number[];
}

const PAIR_RE = /(-?[\d.]+)\s*\(([\d.]+)\)/g;

/**
 * Parse a realtime2 frequency-keyed file into rows, newest first as in the
 * file. `hasSepFreq` skips the Sep_Freq column that only data_spec has.
 * When `truncated`, the final line is a partial row from a byte range and
 * is dropped.
 */
export function parseSpectralFile(text: string, hasSepFreq: boolean, truncated = false): ParsedRow[] {
  const lines = text.split('\n');
  if (truncated && !text.endsWith('\n')) lines.pop();
  const rows: ParsedRow[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 6) continue;
    const [yy, mm, dd, hh, mi] = tokens as [string, string, string, string, string, ...string[]];
    const rest = tokens.slice(hasSepFreq ? 6 : 5).join(' ');
    const freqs: number[] = [];
    const values: number[] = [];
    for (const m of rest.matchAll(PAIR_RE)) {
      values.push(Number(m[1]));
      freqs.push(Number(m[2]));
    }
    if (freqs.length === 0) continue;
    let year = Number(yy);
    if (year < 100) year += 2000;
    rows.push({ time: `${String(year).padStart(4, '0')}-${mm}-${dd}T${hh}:${mi}`, freqs, values });
  }
  return rows;
}

/** Join the energy rows with the four directional files on timestamp; oldest first. */
export function mergeSpectralFiles(
  spec: ParsedRow[], swdir: ParsedRow[] | null, swdir2: ParsedRow[] | null,
  swr1: ParsedRow[] | null, swr2: ParsedRow[] | null,
): SpectrumRecord[] {
  const index = (rows: ParsedRow[] | null): Map<string, ParsedRow> => {
    const m = new Map<string, ParsedRow>();
    for (const r of rows ?? []) m.set(r.time, r);
    return m;
  };
  const dirFiles = [index(swdir), index(swdir2), index(swr1), index(swr2)];

  const records: SpectrumRecord[] = [];
  for (const row of spec) {
    const rec: SpectrumRecord = { time: row.time, freqs: row.freqs, energy: row.values, hasDirection: false };
    const parts = dirFiles.map((m) => m.get(row.time));
    const complete = parts.every((p) => p && sameFreqs(p.freqs, row.freqs));
    if (complete) {
      const [a1, a2, r1, r2] = parts as [ParsedRow, ParsedRow, ParsedRow, ParsedRow];
      rec.alpha1 = a1.values;
      rec.alpha2 = a2.values;
      rec.r1 = r1.values;
      rec.r2 = r2.values;
      rec.hasDirection = true;
    }
    records.push(rec);
  }
  records.sort((a, b) => a.time.localeCompare(b.time));
  return records;
}

function sameFreqs(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > 1e-6) return false;
  return true;
}
