/**
 * NOAA CO-OPS API client for harmonic constituent data.
 *
 * Fetches harmonic constants, datum offsets, and subordinate station
 * offsets from the NOAA Metadata API, with in-memory caching.
 */

import type {
  StationHarmonic, StationDatum, SubordinateOffsets,
  CurrentHarmonic, SubordinateCurrentOffsets,
} from './predict.js';
import { constituentSpeed } from './predict.js';

const META_BASE = 'https://api.tidesandcurrents.noaa.gov/mdapi/prod/webapi';

// ---------------------------------------------------------------------------
// Types for NOAA API responses
// ---------------------------------------------------------------------------

interface HarconResponse {
  units: string;
  HarmonicConstituents: Array<{
    number?: number;
    name?: string;
    constituentName?: string;
    amplitude?: number;
    phase_GMT?: number;
    phase_local?: number;
    speed?: number;
    // Current-specific fields
    majorAmplitude?: number;
    majorPhaseGMT?: number;
    minorAmplitude?: number;
    minorPhaseGMT?: number;
    azi?: number;
    binNbr?: number;
  }>;
}

interface DatumsResponse {
  units: string;
  datums: Array<{ name: string; value: number }> | null;
}

interface OffsetsResponse {
  refStationId: string;
  type: string;
  heightOffsetHighTide: number;
  heightOffsetLowTide: number;
  timeOffsetHighTide: number;
  timeOffsetLowTide: number;
  heightAdjustedType: string;
}

interface CurrentOffsetsResponse {
  id: string;
  refStationId: string;
  refStationBin: number;
  meanFloodDir: number;
  meanEbbDir: number;
  mfcTimeAdjMin: number;
  sbeTimeAdjMin: number;
  mecTimeAdjMin: number;
  sbfTimeAdjMin: number;
  mfcAmpAdj: number;
  mecAmpAdj: number;
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const harmonicCache = new Map<string, StationHarmonic[]>();
const currentHarmonicCache = new Map<string, CurrentHarmonic[]>();
const datumCache = new Map<string, StationDatum>();
const offsetCache = new Map<string, SubordinateOffsets>();
const currentOffsetCache = new Map<string, SubordinateCurrentOffsets>();

// ---------------------------------------------------------------------------
// Tide station API
// ---------------------------------------------------------------------------

/**
 * Fetch harmonic constituents for a tide station.
 * Returns empty array if the station has no harmonic data (subordinate stations).
 */
export async function fetchHarmonics(stationId: string): Promise<StationHarmonic[]> {
  const cached = harmonicCache.get(stationId);
  if (cached) return cached;

  const url = `${META_BASE}/stations/${stationId}/harcon.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching harmonics for ${stationId}`);

  const data: HarconResponse = await resp.json();
  const harmonics: StationHarmonic[] = (data.HarmonicConstituents ?? [])
    .filter((c) => c.name && c.amplitude != null && c.phase_GMT != null && c.speed != null)
    .map((c) => ({
      name: c.name!,
      amplitude: c.amplitude!,
      phase_GMT: c.phase_GMT!,
      speed: c.speed!,
    }));

  harmonicCache.set(stationId, harmonics);
  return harmonics;
}

/**
 * Fetch datum information for a station.
 * Returns MSL offset above station datum reference (MLLW).
 */
export async function fetchDatum(stationId: string): Promise<StationDatum> {
  const cached = datumCache.get(stationId);
  if (cached) return cached;

  const url = `${META_BASE}/stations/${stationId}/datums.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching datums for ${stationId}`);

  const data: DatumsResponse = await resp.json();
  const datums = data.datums ?? [];

  const mslEntry = datums.find((d) => d.name === 'MSL');
  const mllwEntry = datums.find((d) => d.name === 'MLLW');

  let msl = 0;
  if (mslEntry && mllwEntry) {
    msl = mslEntry.value - mllwEntry.value;
  } else if (mslEntry) {
    msl = mslEntry.value;
  }

  const datum: StationDatum = { msl };
  datumCache.set(stationId, datum);
  return datum;
}

/**
 * Fetch subordinate tide station offsets.
 */
export async function fetchSubordinateOffsets(stationId: string): Promise<SubordinateOffsets | null> {
  const cached = offsetCache.get(stationId);
  if (cached) return cached;

  const url = `${META_BASE}/stations/${stationId}/tidepredoffsets.json`;
  const resp = await fetch(url);
  if (!resp.ok) return null;

  const data: OffsetsResponse = await resp.json();
  if (!data.refStationId) return null;

  const offsets: SubordinateOffsets = {
    refStationId: data.refStationId,
    timeOffsetHighTide: data.timeOffsetHighTide ?? 0,
    timeOffsetLowTide: data.timeOffsetLowTide ?? 0,
    heightOffsetHighTide: data.heightOffsetHighTide ?? 1,
    heightOffsetLowTide: data.heightOffsetLowTide ?? 1,
    heightAdjustedType: data.heightAdjustedType === 'A' ? 'A' : 'R',
  };

  offsetCache.set(stationId, offsets);
  return offsets;
}

/**
 * High-level: generate a tide prediction series for any station type.
 */
export async function generatePrediction(
  stationId: string,
  stationType: string,
  start: Date,
  end: Date,
  stepMin = 6,
): Promise<Array<{ t: number; v: number }>> {
  const { predictTideSeries, predictSubordinateSeries } = await import('./predict.js');

  if (stationType === 'R') {
    const [harmonics, datum] = await Promise.all([
      fetchHarmonics(stationId),
      fetchDatum(stationId),
    ]);
    if (harmonics.length === 0) throw new Error('No harmonic data available');
    return predictTideSeries(start, end, stepMin, harmonics, datum);
  } else {
    const offsets = await fetchSubordinateOffsets(stationId);
    if (!offsets) throw new Error('No subordinate offsets available');

    const [refHarmonics, refDatum] = await Promise.all([
      fetchHarmonics(offsets.refStationId),
      fetchDatum(offsets.refStationId),
    ]);
    if (refHarmonics.length === 0) throw new Error('No harmonic data for reference station');
    return predictSubordinateSeries(start, end, stepMin, refHarmonics, refDatum, offsets);
  }
}

// ---------------------------------------------------------------------------
// Current station API
// ---------------------------------------------------------------------------

/**
 * Fetch harmonic constituents for a current station (H-type).
 * Current harmonics use different field names than tide harmonics.
 * The `bin` parameter selects the depth bin (default 1 = surface).
 */
export async function fetchCurrentHarmonics(
  stationId: string,
  bin = 1,
): Promise<CurrentHarmonic[]> {
  const cacheKey = `${stationId}_${bin}`;
  const cached = currentHarmonicCache.get(cacheKey);
  if (cached) return cached;

  const url = `${META_BASE}/stations/${stationId}/harcon.json`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching current harmonics for ${stationId}`);

  const data: HarconResponse = await resp.json();
  const harmonics: CurrentHarmonic[] = (data.HarmonicConstituents ?? [])
    .filter((c) => (c.binNbr ?? 1) === bin && c.constituentName && c.majorAmplitude != null)
    .map((c) => ({
      name: c.constituentName!,
      majorAmplitude: c.majorAmplitude!,
      majorPhaseGMT: c.majorPhaseGMT ?? 0,
      speed: constituentSpeed(c.constituentName!),
    }));

  currentHarmonicCache.set(cacheKey, harmonics);
  return harmonics;
}

/**
 * Fetch subordinate current station offsets.
 * Note: the API requires `_{bin}` suffix on the station ID.
 */
export async function fetchCurrentSubordinateOffsets(
  stationId: string,
  bin = 1,
): Promise<SubordinateCurrentOffsets | null> {
  const cacheKey = `${stationId}_${bin}`;
  const cached = currentOffsetCache.get(cacheKey);
  if (cached) return cached;

  const url = `${META_BASE}/stations/${stationId}_${bin}/currentpredictionoffsets.json`;
  const resp = await fetch(url);
  if (!resp.ok) return null;

  const data: CurrentOffsetsResponse = await resp.json();
  if (!data.refStationId) return null;

  const offsets: SubordinateCurrentOffsets = {
    refStationId: data.refStationId,
    refStationBin: data.refStationBin ?? 1,
    meanFloodDir: data.meanFloodDir ?? 0,
    meanEbbDir: data.meanEbbDir ?? 0,
    mfcTimeAdjMin: data.mfcTimeAdjMin ?? 0,
    sbeTimeAdjMin: data.sbeTimeAdjMin ?? 0,
    mecTimeAdjMin: data.mecTimeAdjMin ?? 0,
    sbfTimeAdjMin: data.sbfTimeAdjMin ?? 0,
    mfcAmpAdj: data.mfcAmpAdj ?? 1,
    mecAmpAdj: data.mecAmpAdj ?? 1,
  };

  currentOffsetCache.set(cacheKey, offsets);
  return offsets;
}

/**
 * High-level: generate a current prediction series for any current station type.
 *
 * @param stationId   Station ID
 * @param stationType 'H' (harmonic), 'S' (subordinate), or 'W' (weak — no harmonics)
 * @param start       Start of prediction window
 * @param end         End of prediction window
 * @param stepMin     Step size in minutes (default 6)
 * @returns Series of {t, v} where v is velocity in knots (positive=flood, negative=ebb)
 */
export async function generateCurrentPrediction(
  stationId: string,
  stationType: string,
  start: Date,
  end: Date,
  stepMin = 6,
): Promise<{ series: Array<{ t: number; v: number }>; floodDir: number; ebbDir: number }> {
  const { predictCurrentSeries, predictSubordinateCurrentSeries } = await import('./predict.js');

  if (stationType === 'H') {
    // Harmonic station — compute directly
    const harmonics = await fetchCurrentHarmonics(stationId);
    if (harmonics.length === 0) throw new Error('No harmonic data available');

    const series = predictCurrentSeries(start, end, stepMin, harmonics);

    // Get direction from first constituent's azimuth
    const url = `${META_BASE}/stations/${stationId}/harcon.json`;
    const resp = await fetch(url);
    const data: HarconResponse = await resp.json();
    const first = data.HarmonicConstituents?.[0];
    const azi = first?.azi ?? 0;

    return { series, floodDir: azi, ebbDir: (azi + 180) % 360 };
  } else if (stationType === 'S') {
    // Subordinate station — get offsets, then compute from reference
    const offsets = await fetchCurrentSubordinateOffsets(stationId);
    if (!offsets) throw new Error('No subordinate offsets available');

    const refHarmonics = await fetchCurrentHarmonics(
      offsets.refStationId,
      offsets.refStationBin,
    );
    if (refHarmonics.length === 0) throw new Error('No harmonic data for reference station');

    const series = predictSubordinateCurrentSeries(
      start, end, stepMin, refHarmonics, offsets,
    );

    return {
      series,
      floodDir: offsets.meanFloodDir,
      ebbDir: offsets.meanEbbDir,
    };
  } else {
    // W-type (weak) — no harmonic data available
    throw new Error('No harmonic data for weak current stations');
  }
}
