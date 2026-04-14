/**
 * Harmonic tide prediction engine — a TypeScript port of the core XTide
 * algorithm. Computes water level predictions from NOAA harmonic constituents
 * using the standard Schureman formulations.
 *
 * The tidal height at time t is:
 *   h(t) = Z0 + Σ f_i · A_i · cos(V0_i(t) + u_i − κ_i)
 *
 * where:
 *   Z0  = mean water level above the chosen datum
 *   f_i = node factor (amplitude modulation from 18.6-year lunar node cycle)
 *   A_i = harmonic amplitude (from NOAA harcon data)
 *   V0_i= equilibrium argument (astronomical phase at time t)
 *   u_i = nodal phase correction
 *   κ_i = observed phase lag at the station (phase_GMT from NOAA)
 *
 * Reference: NOAA Special Publication 98 (Schureman, 1958)
 */

const DEG = Math.PI / 180;

// ---------------------------------------------------------------------------
// Astronomical arguments
// ---------------------------------------------------------------------------

/** Fundamental astronomical parameters at a given time. */
export interface AstroParams {
  /** Solar hour angle: 15° × hours from midnight UTC */
  T: number;
  /** Mean longitude of Moon (degrees) */
  s: number;
  /** Mean longitude of Sun (degrees) */
  h: number;
  /** Mean longitude of lunar perigee (degrees) */
  p: number;
  /** Longitude of ascending lunar node (degrees) */
  N: number;
  /** Mean longitude of solar perigee (degrees) */
  pp: number;
  // Derived intermediate values for node factors
  /** Inclination of lunar orbit to celestial equator */
  I: number;
  /** Right ascension correction */
  nu: number;
  /** Node correction ξ */
  xi: number;
  /** Correction for K1 */
  nup: number;
  /** Correction for K2 */
  nupp: number;
}

/**
 * Compute astronomical parameters at a given Date.
 * Positions from Meeus (1991), simplified to first-order terms.
 */
export function computeAstro(date: Date): AstroParams {
  // Julian date
  const jd = date.getTime() / 86400000 + 2440587.5;
  // Julian centuries from J2000.0 (2000-01-01 12:00 UTC)
  const T_cent = (jd - 2451545.0) / 36525.0;

  // Greenwich mean solar hour angle. At midnight UTC the sun is at the
  // anti-meridian, so the hour angle starts at 180°.
  const hours = date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600;
  const T_hour = 15.0 * hours + 180.0;

  // Mean longitude of Moon (degrees) — Meeus (1991) higher-precision
  const s = mod360(218.3164477 + 481267.88123421 * T_cent
    - 0.0015786 * T_cent * T_cent);
  // Mean longitude of Sun (degrees)
  const h = mod360(280.46646 + 36000.76983 * T_cent
    + 0.0003032 * T_cent * T_cent);
  // Mean longitude of lunar perigee (degrees)
  const p = mod360(83.3532465 + 4069.01363525 * T_cent
    - 0.01032172 * T_cent * T_cent);
  // Longitude of ascending lunar node (degrees)
  const N = mod360(125.04452 - 1934.13626197 * T_cent
    + 0.00207028 * T_cent * T_cent);
  // Mean longitude of solar perigee (degrees)
  const pp = mod360(282.93768 + 1.71946 * T_cent
    + 0.00045688 * T_cent * T_cent);

  // Intermediate values for node factors (Schureman formulas)
  const N_rad = N * DEG;
  const cosN = Math.cos(N_rad);
  const sinN = Math.sin(N_rad);

  const I = Math.acos(0.91370 - 0.03569 * cosN);
  const sinI = Math.sin(I);
  const cosI = Math.cos(I);
  const cosI2 = Math.cos(I / 2);
  const sinI2 = Math.sin(I / 2);

  const nu = Math.asin(0.08960 * sinN / sinI);

  // ξ = N - 2·atan(0.6441·tan(N/2)) - ν
  const xi = N_rad - 2 * Math.atan(0.6441 * Math.tan(N_rad / 2)) - nu;

  // ν' for K1
  const sin2I = Math.sin(2 * I);
  const nup = Math.atan2(sin2I * Math.sin(nu), sin2I * Math.cos(nu) + 0.3347);

  // ν'' for K2
  const sinI2sq = sinI * sinI;
  const nupp = Math.atan2(sinI2sq * Math.sin(2 * nu), sinI2sq * Math.cos(2 * nu) + 0.0727);

  return {
    T: T_hour,
    s, h, p, N, pp,
    I: I / DEG,     // store in degrees for V0 computations
    nu: nu / DEG,
    xi: xi / DEG,
    nup: nup / DEG,
    nupp: nupp / DEG,
  };
}

// ---------------------------------------------------------------------------
// Constituent definitions — the 37 standard NOAA constituents
// ---------------------------------------------------------------------------

/**
 * Each constituent defines how to compute V0 (equilibrium argument),
 * f (node factor), and u (nodal phase correction) from astronomical params.
 */
interface ConstituentSpec {
  /** Compute V0 in degrees from astronomical parameters */
  V0: (a: AstroParams) => number;
  /** Compute node factor f (dimensionless, ~1.0) */
  f: (a: AstroParams) => number;
  /** Compute phase correction u in degrees */
  u: (a: AstroParams) => number;
}

// Shorthands for common node factor formulas (from Schureman Table 2)

/** f = 1.0 — used for solar constituents */
const f_1 = (): number => 1.0;

/** f for M2 and related semidiurnal lunar constituents */
function f_M2(a: AstroParams): number {
  const I = a.I * DEG;
  const c = Math.cos(I / 2);
  return (c * c * c * c) / 0.91544;
}

/** f for O1 and related diurnal lunar constituents */
function f_O1(a: AstroParams): number {
  const I = a.I * DEG;
  return Math.sin(I) * Math.cos(I / 2) * Math.cos(I / 2) / 0.37988;
}

/** f for K1 */
function f_K1(a: AstroParams): number {
  const I = a.I * DEG;
  const nu = a.nu * DEG;
  const sin2I = Math.sin(2 * I);
  return Math.sqrt(0.8965 * sin2I * sin2I + 0.6001 * sin2I * Math.cos(nu) + 0.1006);
}

/** f for K2 */
function f_K2(a: AstroParams): number {
  const I = a.I * DEG;
  const nu = a.nu * DEG;
  const sinI = Math.sin(I);
  const sin2I = sinI * sinI;
  return Math.sqrt(19.0444 * sin2I * sin2I + 2.7702 * sin2I * Math.cos(2 * nu) + 0.0981);
}

/** f for J1 */
function f_J1(a: AstroParams): number {
  const I = a.I * DEG;
  return Math.sin(2 * I) / 0.37988;
}

/** f for OO1 */
function f_OO1(a: AstroParams): number {
  const I = a.I * DEG;
  const sinI = Math.sin(I);
  return sinI * sinI * sinI / 0.01640;
}

/** f for M1 */
function f_M1(a: AstroParams): number {
  // Approximate — M1 node factor is close to O1
  return f_O1(a);
}

/** f for Mm (lunar monthly) */
function f_Mm(a: AstroParams): number {
  const I = a.I * DEG;
  const sinI = Math.sin(I);
  return (2.0 / 3.0 - sinI * sinI) / 0.5021;
}

/** f for Mf (lunisolar fortnightly) */
function f_Mf(a: AstroParams): number {
  const I = a.I * DEG;
  const sinI = Math.sin(I);
  return sinI * sinI / 0.1578;
}

// u corrections

const u_0 = (): number => 0;

function u_M2(a: AstroParams): number {
  return 2 * a.xi - 2 * a.nu;
}

function u_O1(a: AstroParams): number {
  return 2 * a.xi - a.nu;
}

function u_K1(a: AstroParams): number {
  return -a.nup;
}

function u_K2(a: AstroParams): number {
  return -a.nupp;
}

function u_J1(a: AstroParams): number {
  return -a.nu;
}

function u_OO1(a: AstroParams): number {
  return -2 * a.xi - a.nu;
}

function u_Mf(a: AstroParams): number {
  return -2 * a.xi;
}

// V0 formulas — equilibrium argument at time t
// Uses the T-convention: V0 is expressed in terms of T (solar hour angle),
// s (moon), h (sun), p (perigee), N' (-N), pp (solar perigee).
//
// The Doodson (τ-convention) numbers are converted via: τ = T + h - s

const CONSTITUENTS: Record<string, ConstituentSpec> = {
  // --- Semidiurnal ---
  'M2':   { V0: (a) => 2*a.T - 2*a.s + 2*a.h,                      f: f_M2,  u: u_M2 },
  'S2':   { V0: (a) => 2*a.T,                                        f: f_1,   u: u_0 },
  'N2':   { V0: (a) => 2*a.T - 3*a.s + 2*a.h + a.p,                 f: f_M2,  u: u_M2 },
  'K2':   { V0: (a) => 2*a.T + 2*a.h,                                f: f_K2,  u: u_K2 },
  'NU2':  { V0: (a) => 2*a.T - 3*a.s + 4*a.h - a.p,                 f: f_M2,  u: u_M2 },
  'MU2':  { V0: (a) => 2*a.T - 4*a.s + 4*a.h,                       f: f_M2,  u: u_M2 },
  '2N2':  { V0: (a) => 2*a.T - 4*a.s + 2*a.h + 2*a.p,               f: f_M2,  u: u_M2 },
  'LAM2': { V0: (a) => 2*a.T - a.s + 2*a.p + 180,                   f: f_M2,  u: u_M2 },
  'T2':   { V0: (a) => 2*a.T - a.h + a.pp,                           f: f_1,   u: u_0 },
  'R2':   { V0: (a) => 2*a.T + a.h - a.pp + 180,                    f: f_1,   u: u_0 },
  '2SM2': { V0: (a) => 2*a.T + 2*a.s - 2*a.h,                       f: f_M2,  u: (a) => -u_M2(a) },
  'L2':   { V0: (a) => 2*a.T - a.s + 2*a.h - a.p + 180,             f: f_M2,  u: u_M2 },

  // --- Diurnal ---
  'K1':   { V0: (a) => a.T + a.h - 90,                               f: f_K1,  u: u_K1 },
  'O1':   { V0: (a) => a.T - 2*a.s + a.h + 90,                       f: f_O1,  u: u_O1 },
  'P1':   { V0: (a) => a.T - a.h + 90,                                f: f_1,   u: u_0 },
  'Q1':   { V0: (a) => a.T - 3*a.s + a.h + a.p + 90,                 f: f_O1,  u: u_O1 },
  '2Q1':  { V0: (a) => a.T - 4*a.s + a.h + 2*a.p + 90,               f: f_O1,  u: u_O1 },
  'RHO':  { V0: (a) => a.T - 3*a.s + 3*a.h - a.p + 90,               f: f_O1,  u: u_O1 },
  'J1':   { V0: (a) => a.T + a.s + a.h - a.p - 90,                   f: f_J1,  u: u_J1 },
  'OO1':  { V0: (a) => a.T + 2*a.s + a.h - 90,                       f: f_OO1, u: u_OO1 },
  'M1':   { V0: (a) => a.T - a.s + a.h - 90,                         f: f_M1,  u: u_O1 },
  'S1':   { V0: (a) => a.T,                                           f: f_1,   u: u_0 },

  // --- Terdiurnal ---
  'MK3':  { V0: (a) => 3*a.T - 2*a.s + 3*a.h - 90,                  f: (a) => f_M2(a) * f_K1(a), u: (a) => u_M2(a) + u_K1(a) },
  '2MK3': { V0: (a) => 3*a.T - 4*a.s + 3*a.h + 90,                  f: (a) => f_M2(a) * f_K1(a), u: (a) => u_M2(a) + u_K1(a) },
  'M3':   { V0: (a) => 3*a.T - 3*a.s + 3*a.h,                       f: (a) => { const m = f_M2(a); return m * Math.sqrt(m); }, u: (a) => 1.5 * u_M2(a) },

  // --- Quarter-diurnal (shallow water) ---
  'M4':   { V0: (a) => 4*a.T - 4*a.s + 4*a.h,                       f: (a) => f_M2(a) ** 2, u: (a) => 2 * u_M2(a) },
  'MN4':  { V0: (a) => 4*a.T - 5*a.s + 4*a.h + a.p,                 f: (a) => f_M2(a) ** 2, u: (a) => 2 * u_M2(a) },
  'MS4':  { V0: (a) => 4*a.T - 2*a.s + 2*a.h,                       f: f_M2,  u: u_M2 },
  'S4':   { V0: (a) => 4*a.T,                                         f: f_1,   u: u_0 },

  // --- Sixth-diurnal ---
  'M6':   { V0: (a) => 6*a.T - 6*a.s + 6*a.h,                       f: (a) => f_M2(a) ** 3, u: (a) => 3 * u_M2(a) },
  'S6':   { V0: (a) => 6*a.T,                                         f: f_1,   u: u_0 },

  // --- Eighth-diurnal ---
  'M8':   { V0: (a) => 8*a.T - 8*a.s + 8*a.h,                       f: (a) => f_M2(a) ** 4, u: (a) => 4 * u_M2(a) },

  // --- Long-period ---
  'MM':   { V0: (a) => a.s - a.p,                                     f: f_Mm,  u: u_0 },
  'MF':   { V0: (a) => 2*a.s,                                         f: f_Mf,  u: u_Mf },
  'MSF':  { V0: (a) => 2*a.s - 2*a.h,                                 f: f_Mf,  u: u_Mf },
  'SA':   { V0: (a) => a.h,                                            f: f_1,   u: u_0 },
  'SSA':  { V0: (a) => 2*a.h,                                          f: f_1,   u: u_0 },
};

// Constituent speeds in degrees per hour (from NOAA standard tables).
// Current harmonics don't include speed, so we look it up by name.
const CONSTITUENT_SPEEDS: Record<string, number> = {
  'M2': 28.9841042, 'S2': 30.0000000, 'N2': 28.4397295, 'K2': 30.0821373,
  'K1': 15.0410686, 'O1': 13.9430356, 'P1': 14.9589314, 'Q1': 13.3986609,
  'M4': 57.9682084, 'M6': 86.9523127, 'M8': 115.9364169, 'M3': 43.4761563,
  'S4': 60.0000000, 'S6': 90.0000000, 'MN4': 57.4238337, 'MS4': 58.9841042,
  'MK3': 44.0251729, '2MK3': 42.9271398, 'NU2': 28.5125831, 'MU2': 27.9682084,
  '2N2': 27.8953548, 'LAM2': 29.4556253, 'T2': 29.9589333, 'R2': 30.0410667,
  '2SM2': 31.0158958, 'L2': 29.5284789, 'OO1': 16.1391017, 'J1': 15.5854433,
  'M1': 14.4966939, 'RHO': 13.4715145, '2Q1': 12.8542862, 'S1': 15.0000000,
  'MM': 0.5443747, 'MF': 1.0980331, 'MSF': 1.0158958, 'SA': 0.0410686,
  'SSA': 0.0821373,
};

/** Look up the angular speed for a constituent by name. */
export function constituentSpeed(name: string): number {
  return CONSTITUENT_SPEEDS[name] ?? 0;
}

// ---------------------------------------------------------------------------
// Prediction engine
// ---------------------------------------------------------------------------

/** Harmonic constants for one constituent at a station. */
export interface StationHarmonic {
  name: string;
  amplitude: number;     // feet or meters
  phase_GMT: number;     // κ — observed phase lag in degrees (GMT reference)
  speed: number;         // degrees per hour
}

/** Datum offset — mean sea level above MLLW. */
export interface StationDatum {
  /** MSL value relative to station datum (feet above MLLW). */
  msl: number;
}

/**
 * Compute tidal height at a single time.
 *
 * @param date     Prediction time
 * @param harmonics Array of harmonic constants from NOAA harcon API
 * @param datum    Datum offset (MSL above MLLW)
 * @returns Height in feet above MLLW
 */
export function predictTideHeight(
  date: Date,
  harmonics: StationHarmonic[],
  datum: StationDatum,
): number {
  const astro = computeAstro(date);
  let height = datum.msl;

  for (const hc of harmonics) {
    const spec = CONSTITUENTS[hc.name];
    if (!spec || hc.amplitude === 0) continue;

    const V0 = mod360(spec.V0(astro));
    const f = spec.f(astro);
    const u = spec.u(astro);

    const arg = (V0 + u - hc.phase_GMT) * DEG;
    height += f * hc.amplitude * Math.cos(arg);
  }

  return height;
}

/**
 * Compute tidal height using pre-computed astronomical parameters.
 * Use this when computing many stations at the same time — call
 * `computeAstro(date)` once and pass it to each station.
 */
export function predictTideHeightWithAstro(
  astro: AstroParams,
  harmonics: StationHarmonic[],
  datum: StationDatum,
): number {
  let height = datum.msl;
  for (const hc of harmonics) {
    const spec = CONSTITUENTS[hc.name];
    if (!spec || hc.amplitude === 0) continue;
    const V0 = mod360(spec.V0(astro));
    const f = spec.f(astro);
    const u = spec.u(astro);
    height += f * hc.amplitude * Math.cos((V0 + u - hc.phase_GMT) * DEG);
  }
  return height;
}

/**
 * Compute current velocity at a single time using pre-computed astro params.
 * Returns velocity in knots (positive = flood, negative = ebb).
 */
export function predictCurrentVelocityWithAstro(
  astro: AstroParams,
  harmonics: CurrentHarmonic[],
): number {
  let velocity = 0;
  for (const hc of harmonics) {
    const spec = CONSTITUENTS[hc.name];
    if (!spec || hc.majorAmplitude === 0 || hc.speed === 0) continue;
    const V0 = mod360(spec.V0(astro));
    const f = spec.f(astro);
    const u = spec.u(astro);
    velocity += f * hc.majorAmplitude * CMS_TO_KNOTS * Math.cos((V0 + u - hc.majorPhaseGMT) * DEG);
  }
  return velocity;
}

/**
 * Generate a time series of predictions.
 *
 * @param start     Start time
 * @param end       End time
 * @param stepMin   Step size in minutes (default 6 — matches NOAA)
 * @param harmonics Harmonic constants
 * @param datum     Datum offset
 * @returns Array of {t: ms-since-epoch, v: height-in-feet}
 */
export function predictTideSeries(
  start: Date,
  end: Date,
  stepMin: number,
  harmonics: StationHarmonic[],
  datum: StationDatum,
): Array<{ t: number; v: number }> {
  const stepMs = stepMin * 60 * 1000;
  const results: Array<{ t: number; v: number }> = [];

  // For efficiency, compute astronomical params at the midpoint and use
  // speed × dt for the fast-varying part. Node factors (f, u) and slowly-
  // varying astronomical args are recomputed every 24 hours.
  const midTime = new Date((start.getTime() + end.getTime()) / 2);
  const astro = computeAstro(midTime);

  // Pre-compute per-constituent values (valid for the prediction window)
  const active: Array<{
    amplitude: number;
    speed_rad_per_ms: number;
    phase0: number; // V0 + u - κ at midTime, in radians
    f: number;
  }> = [];

  for (const hc of harmonics) {
    const spec = CONSTITUENTS[hc.name];
    if (!spec || hc.amplitude === 0) continue;

    const V0 = mod360(spec.V0(astro));
    const f = spec.f(astro);
    const u = spec.u(astro);

    active.push({
      amplitude: hc.amplitude,
      speed_rad_per_ms: hc.speed * DEG / 3600000,
      phase0: (V0 + u - hc.phase_GMT) * DEG,
      f,
    });
  }

  const midMs = midTime.getTime();

  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const dt = t - midMs;
    let height = datum.msl;
    for (const c of active) {
      height += c.f * c.amplitude * Math.cos(c.phase0 + c.speed_rad_per_ms * dt);
    }
    results.push({ t, v: height });
  }

  return results;
}

/**
 * Apply subordinate station offsets to a reference station's high/low predictions.
 *
 * The NOAA tide prediction offset format:
 *   - timeOffsetHighTide / timeOffsetLowTide: minutes to add
 *   - heightOffsetHighTide / heightOffsetLowTide: multiplier (if type=R) or additive (if type=A)
 *   - heightAdjustedType: "R" (ratio) or "A" (additive)
 *
 * For a full curve, we interpolate a smooth tide curve from the adjusted highs and lows.
 */
export interface SubordinateOffsets {
  refStationId: string;
  timeOffsetHighTide: number;  // minutes
  timeOffsetLowTide: number;   // minutes
  heightOffsetHighTide: number;
  heightOffsetLowTide: number;
  heightAdjustedType: 'R' | 'A'; // R=ratio, A=additive
}

/**
 * Find high and low water extremes from a prediction series.
 */
export function findExtremes(
  series: Array<{ t: number; v: number }>,
): Array<{ t: number; v: number; type: 'H' | 'L' }> {
  const extremes: Array<{ t: number; v: number; type: 'H' | 'L' }> = [];

  for (let i = 1; i < series.length - 1; i++) {
    const prev = series[i - 1]!.v;
    const curr = series[i]!.v;
    const next = series[i + 1]!.v;

    if (curr > prev && curr > next) {
      extremes.push({ t: series[i]!.t, v: curr, type: 'H' });
    } else if (curr < prev && curr < next) {
      extremes.push({ t: series[i]!.t, v: curr, type: 'L' });
    }
  }

  return extremes;
}

/**
 * Generate predictions for a subordinate station by computing the reference
 * station's extremes, applying offsets, and cosine-interpolating a smooth curve.
 */
export function predictSubordinateSeries(
  start: Date,
  end: Date,
  stepMin: number,
  refHarmonics: StationHarmonic[],
  refDatum: StationDatum,
  offsets: SubordinateOffsets,
): Array<{ t: number; v: number }> {
  // Extend the reference prediction window to capture extremes near the edges
  const pad = 12 * 3600000; // 12 hours
  const refStart = new Date(start.getTime() - pad);
  const refEnd = new Date(end.getTime() + pad);

  // Generate dense reference predictions to find extremes accurately
  const refSeries = predictTideSeries(refStart, refEnd, 6, refHarmonics, refDatum);
  const refExtremes = findExtremes(refSeries);

  if (refExtremes.length < 2) {
    // Not enough data — fall back to direct prediction (shouldn't happen)
    return predictTideSeries(start, end, stepMin, refHarmonics, refDatum);
  }

  // Apply offsets to each extreme
  const adjusted = refExtremes.map((ext) => {
    const isHigh = ext.type === 'H';
    const timeOffset = isHigh ? offsets.timeOffsetHighTide : offsets.timeOffsetLowTide;
    const heightOffset = isHigh ? offsets.heightOffsetHighTide : offsets.heightOffsetLowTide;

    let v: number;
    if (offsets.heightAdjustedType === 'R') {
      v = ext.v * heightOffset;
    } else {
      v = ext.v + heightOffset;
    }

    return { t: ext.t + timeOffset * 60000, v, type: ext.type };
  });

  // Cosine-interpolate between the adjusted extremes
  return cosineInterpolateSeries(adjusted, start.getTime(), end.getTime(), stepMin);
}

/**
 * Cosine-interpolate a smooth curve from sparse high/low extremes.
 */
function cosineInterpolateSeries(
  extremes: Array<{ t: number; v: number }>,
  startMs: number,
  endMs: number,
  stepMin: number,
): Array<{ t: number; v: number }> {
  const stepMs = stepMin * 60 * 1000;
  const results: Array<{ t: number; v: number }> = [];

  for (let t = startMs; t <= endMs; t += stepMs) {
    // Find surrounding extremes
    let segIdx = 0;
    for (let j = 0; j < extremes.length - 1; j++) {
      if (extremes[j]!.t <= t && extremes[j + 1]!.t >= t) {
        segIdx = j;
        break;
      }
      if (j === extremes.length - 2) segIdx = j;
    }

    // Clamp to valid range
    if (t <= extremes[0]!.t) {
      results.push({ t, v: extremes[0]!.v });
      continue;
    }
    if (t >= extremes[extremes.length - 1]!.t) {
      results.push({ t, v: extremes[extremes.length - 1]!.v });
      continue;
    }

    const e0 = extremes[segIdx]!;
    const e1 = extremes[segIdx + 1]!;
    const dt = e1.t - e0.t;
    const frac = dt > 0 ? (t - e0.t) / dt : 0;

    // Cosine interpolation — produces natural sinusoidal tide shape
    const mu = (1 - Math.cos(frac * Math.PI)) / 2;
    const v = e0.v * (1 - mu) + e1.v * mu;

    results.push({ t, v });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Current predictions
// ---------------------------------------------------------------------------

const CMS_TO_KNOTS = 0.0194384; // 1 cm/s = 0.0194384 knots

/** Harmonic constants for one current constituent. */
export interface CurrentHarmonic {
  name: string;
  majorAmplitude: number;  // cm/s
  majorPhaseGMT: number;   // degrees
  speed: number;           // degrees per hour (looked up from constituent name)
}

/**
 * Generate a current velocity time series from harmonic constituents.
 * Returns velocity in knots (positive = flood, negative = ebb).
 */
export function predictCurrentSeries(
  start: Date,
  end: Date,
  stepMin: number,
  harmonics: CurrentHarmonic[],
): Array<{ t: number; v: number }> {
  const stepMs = stepMin * 60 * 1000;
  const results: Array<{ t: number; v: number }> = [];

  const midTime = new Date((start.getTime() + end.getTime()) / 2);
  const astro = computeAstro(midTime);

  const active: Array<{
    amplitude: number;
    speed_rad_per_ms: number;
    phase0: number;
    f: number;
  }> = [];

  for (const hc of harmonics) {
    const spec = CONSTITUENTS[hc.name];
    if (!spec || hc.majorAmplitude === 0 || hc.speed === 0) continue;

    const V0 = mod360(spec.V0(astro));
    const f = spec.f(astro);
    const u = spec.u(astro);

    active.push({
      amplitude: hc.majorAmplitude * CMS_TO_KNOTS,  // convert cm/s → knots
      speed_rad_per_ms: hc.speed * DEG / 3600000,
      phase0: (V0 + u - hc.majorPhaseGMT) * DEG,
      f,
    });
  }

  const midMs = midTime.getTime();

  for (let t = start.getTime(); t <= end.getTime(); t += stepMs) {
    const dt = t - midMs;
    let velocity = 0;
    for (const c of active) {
      velocity += c.f * c.amplitude * Math.cos(c.phase0 + c.speed_rad_per_ms * dt);
    }
    results.push({ t, v: velocity });
  }

  return results;
}

/** Subordinate current station offsets. */
export interface SubordinateCurrentOffsets {
  refStationId: string;
  refStationBin: number;
  meanFloodDir: number;
  meanEbbDir: number;
  /** Time adjustments in minutes for max flood/ebb and slack before flood/ebb */
  mfcTimeAdjMin: number;
  sbeTimeAdjMin: number;
  mecTimeAdjMin: number;
  sbfTimeAdjMin: number;
  /** Amplitude multipliers for max flood/ebb */
  mfcAmpAdj: number;
  mecAmpAdj: number;
}

/**
 * Generate predictions for a subordinate current station.
 * Computes reference station extremes, applies time/amplitude offsets,
 * then cosine-interpolates.
 */
export function predictSubordinateCurrentSeries(
  start: Date,
  end: Date,
  stepMin: number,
  refHarmonics: CurrentHarmonic[],
  offsets: SubordinateCurrentOffsets,
): Array<{ t: number; v: number }> {
  const pad = 12 * 3600000;
  const refStart = new Date(start.getTime() - pad);
  const refEnd = new Date(end.getTime() + pad);

  const refSeries = predictCurrentSeries(refStart, refEnd, 6, refHarmonics);
  const refExtremes = findExtremes(refSeries);

  if (refExtremes.length < 2) {
    return predictCurrentSeries(start, end, stepMin, refHarmonics);
  }

  // Apply offsets: H = max flood, L = max ebb
  // Also insert slack water points (v=0) between extremes with time offsets
  const adjusted: Array<{ t: number; v: number }> = [];

  for (const ext of refExtremes) {
    if (ext.type === 'H') {
      // Max flood current
      adjusted.push({
        t: ext.t + offsets.mfcTimeAdjMin * 60000,
        v: ext.v * offsets.mfcAmpAdj,
      });
    } else {
      // Max ebb current
      adjusted.push({
        t: ext.t + offsets.mecTimeAdjMin * 60000,
        v: ext.v * offsets.mecAmpAdj,
      });
    }
  }

  // Insert slack water points (v=0) between each pair of extremes.
  // Slack before flood uses sbfTimeAdjMin, slack before ebb uses sbeTimeAdjMin.
  const withSlack: Array<{ t: number; v: number }> = [];
  for (let i = 0; i < adjusted.length; i++) {
    withSlack.push(adjusted[i]!);
    if (i < adjusted.length - 1) {
      const curr = adjusted[i]!;
      const next = adjusted[i + 1]!;
      const midT = (curr.t + next.t) / 2;
      // Determine slack type based on next extreme
      const timeAdj = next.v > 0
        ? offsets.sbfTimeAdjMin * 60000  // slack before flood
        : offsets.sbeTimeAdjMin * 60000; // slack before ebb
      withSlack.push({ t: midT + timeAdj, v: 0 });
    }
  }

  // Sort by time to ensure monotonic
  withSlack.sort((a, b) => a.t - b.t);

  return cosineInterpolateSeries(withSlack, start.getTime(), end.getTime(), stepMin);
}

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

function mod360(deg: number): number {
  return ((deg % 360) + 360) % 360;
}
