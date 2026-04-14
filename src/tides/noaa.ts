/**
 * NOAA CO-OPS API client for harmonic constituent data.
 *
 * Fetches harmonic constants, datum offsets, and subordinate station
 * offsets from the NOAA Metadata API, with in-memory caching.
 */

import {
  constituentSpeed,
  predictTideSeries, predictSubordinateSeries,
  predictCurrentSeries, predictSubordinateCurrentSeries,
} from './predict.js';
import type {
  StationHarmonic, StationDatum, SubordinateOffsets,
  CurrentHarmonic, SubordinateCurrentOffsets,
} from './predict.js';

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
// Local storage persistence
// ---------------------------------------------------------------------------

const LS_CONSENT_KEY = 'gribwebview-harmonic-cache-consent';
const LS_STORE_KEY = 'gribwebview-harmonics';

/** Check if the user has accepted local caching. */
function hasCacheConsent(): boolean {
  return localStorage.getItem(LS_CONSENT_KEY) === 'yes';
}

let cachePromptShown = false;

/** Prompt the user to accept local caching. Called once per page load if not accepted. */
export function promptCacheConsent(): void {
  if (hasCacheConsent()) return;
  if (cachePromptShown) return;
  cachePromptShown = true;

  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:9999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.5);';

  const dialog = document.createElement('div');
  dialog.style.cssText = 'background:#161b22;color:#e6edf3;border:1px solid #30363d;border-radius:8px;padding:20px 24px;max-width:380px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;box-shadow:0 8px 32px rgba(0,0,0,0.6);';
  dialog.innerHTML = `
    <div style="font-size:14px;font-weight:bold;margin-bottom:10px;">Cache Harmonic Data</div>
    <p style="color:#8b949e;margin:0 0 14px;line-height:1.5;">
      Cache tide and current harmonic data locally to speed up future predictions.
    </p>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button id="cache-deny" style="background:#21262d;color:#8b949e;border:1px solid #30363d;border-radius:4px;padding:5px 14px;cursor:pointer;font-family:inherit;font-size:11px;">Not Now</button>
      <button id="cache-accept" style="background:#238636;color:#ffffff;border:1px solid #2ea043;border-radius:4px;padding:5px 14px;cursor:pointer;font-family:inherit;font-size:11px;">Cache Locally</button>
    </div>`;

  overlay.appendChild(dialog);
  document.body.appendChild(overlay);

  dialog.querySelector('#cache-accept')!.addEventListener('click', () => {
    localStorage.setItem(LS_CONSENT_KEY, 'yes');
    overlay.remove();
    // Persist everything currently in memory
    persistAllCaches();
  });

  dialog.querySelector('#cache-deny')!.addEventListener('click', () => {
    overlay.remove();
    // Don't set consent — will ask again next page load
  });
}

/** Save all in-memory caches to localStorage. Evicts oldest entries if over 4MB. */
function persistAllCaches(): void {
  if (!hasCacheConsent()) return;
  try {
    const store: Record<string, unknown> = {};
    const tideH: Record<string, StationHarmonic[]> = {};
    for (const [k, v] of harmonicCache) { if (v.length > 0) tideH[k] = v; }
    store['tideHarmonics'] = tideH;
    const datums: Record<string, StationDatum> = {};
    for (const [k, v] of datumCache) datums[k] = v;
    store['datums'] = datums;
    const tideOff: Record<string, SubordinateOffsets> = {};
    for (const [k, v] of offsetCache) tideOff[k] = v;
    store['tideOffsets'] = tideOff;
    const curH: Record<string, CurrentHarmonic[]> = {};
    for (const [k, v] of currentHarmonicCache) { if (v.length > 0) curH[k] = v; }
    store['currentHarmonics'] = curH;
    const curOff: Record<string, SubordinateCurrentOffsets> = {};
    for (const [k, v] of currentOffsetCache) curOff[k] = v;
    store['currentOffsets'] = curOff;
    const curAzi: Record<string, { floodDir: number; ebbDir: number }> = {};
    for (const [k, v] of currentAziCache) curAzi[k] = v;
    store['currentAzimuths'] = curAzi;

    const json = JSON.stringify(store);
    // Stay under 4MB to leave headroom in the 5MB localStorage quota
    if (json.length > 4 * 1024 * 1024) {
      console.warn(`Harmonic cache too large (${(json.length / 1024 / 1024).toFixed(1)}MB), skipping persist`);
      return;
    }
    localStorage.setItem(LS_STORE_KEY, json);
  } catch (err) {
    console.warn('Failed to persist harmonic cache:', err);
  }
}

/** Hydrate in-memory caches from localStorage on startup. Validates shape. */
function hydrateFromLocalStorage(): void {
  if (!hasCacheConsent()) return;
  try {
    const raw = localStorage.getItem(LS_STORE_KEY);
    if (!raw) return;
    const store = JSON.parse(raw);
    if (typeof store !== 'object' || store === null) return;

    for (const [k, v] of Object.entries(store.tideHarmonics ?? {})) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0].name === 'string')
        harmonicCache.set(k, v as StationHarmonic[]);
    }
    for (const [k, v] of Object.entries(store.datums ?? {})) {
      if (v && typeof (v as StationDatum).msl === 'number')
        datumCache.set(k, v as StationDatum);
    }
    for (const [k, v] of Object.entries(store.tideOffsets ?? {})) {
      if (v && typeof (v as SubordinateOffsets).refStationId === 'string')
        offsetCache.set(k, v as SubordinateOffsets);
    }
    for (const [k, v] of Object.entries(store.currentHarmonics ?? {})) {
      if (Array.isArray(v) && v.length > 0 && typeof v[0].name === 'string')
        currentHarmonicCache.set(k, v as CurrentHarmonic[]);
    }
    for (const [k, v] of Object.entries(store.currentOffsets ?? {})) {
      if (v && typeof (v as SubordinateCurrentOffsets).refStationId === 'string')
        currentOffsetCache.set(k, v as SubordinateCurrentOffsets);
    }
    for (const [k, v] of Object.entries(store.currentAzimuths ?? {})) {
      if (v && typeof (v as { floodDir: number }).floodDir === 'number')
        currentAziCache.set(k, v as { floodDir: number; ebbDir: number });
    }
  } catch {
    // Corrupt data — clear it so we don't keep failing
    try { localStorage.removeItem(LS_STORE_KEY); } catch { /* */ }
  }
}

// Debounce persistence — write at most every 5 seconds
let persistTimer: ReturnType<typeof setTimeout> | null = null;
function schedulePersist(): void {
  if (!hasCacheConsent() || persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistAllCaches();
  }, 5000);
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const harmonicCache = new Map<string, StationHarmonic[]>();
const currentHarmonicCache = new Map<string, CurrentHarmonic[]>();
const currentAziCache = new Map<string, { floodDir: number; ebbDir: number }>();
const datumCache = new Map<string, StationDatum>();
const offsetCache = new Map<string, SubordinateOffsets>();
const currentOffsetCache = new Map<string, SubordinateCurrentOffsets>();

// Hydrate from localStorage on module load
hydrateFromLocalStorage();

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
  schedulePersist();
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
  schedulePersist();
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
  schedulePersist();
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
  // predictTideSeries, predictSubordinateSeries imported statically at top

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
  const allConstituents = data.HarmonicConstituents ?? [];
  const harmonics: CurrentHarmonic[] = allConstituents
    .filter((c) => (c.binNbr ?? 1) === bin && c.constituentName && c.majorAmplitude != null)
    .map((c) => ({
      name: c.constituentName!,
      majorAmplitude: c.majorAmplitude!,
      majorPhaseGMT: c.majorPhaseGMT ?? 0,
      speed: constituentSpeed(c.constituentName!),
    }));

  // Extract azimuth from the first constituent for direction info
  const firstWithAzi = allConstituents.find((c) => (c.binNbr ?? 1) === bin && c.azi != null);
  if (firstWithAzi?.azi != null) {
    currentAziCache.set(cacheKey, { floodDir: firstWithAzi.azi, ebbDir: (firstWithAzi.azi + 180) % 360 });
  }

  currentHarmonicCache.set(cacheKey, harmonics);
  schedulePersist();
  return harmonics;
}

/** Get cached azimuth for a current station (populated by fetchCurrentHarmonics). */
export function getCurrentAzimuth(stationId: string, bin = 1): { floodDir: number; ebbDir: number } | undefined {
  return currentAziCache.get(`${stationId}_${bin}`);
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
  schedulePersist();
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
  // predictCurrentSeries, predictSubordinateCurrentSeries imported statically at top

  if (stationType === 'H') {
    const harmonics = await fetchCurrentHarmonics(stationId);
    if (harmonics.length === 0) throw new Error('No harmonic data available');

    const series = predictCurrentSeries(start, end, stepMin, harmonics);
    const azi = getCurrentAzimuth(stationId) ?? { floodDir: 0, ebbDir: 180 };

    return { series, floodDir: azi.floodDir, ebbDir: azi.ebbDir };
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
