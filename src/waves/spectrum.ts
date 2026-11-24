/**
 * Directional wave spectrum math for NDBC buoy observations.
 *
 * A buoy reports, per frequency bin, the energy density E(f) and four
 * directional moments: the mean direction α1, the principal direction α2
 * and their spreads r1, r2. This module rebuilds the full directional
 * spectrum S(f,θ) from those numbers, then splits it into wave systems
 * (swell trains and wind sea) with a steepest-ascent watershed.
 *
 * Pure functions, no DOM: see test/spectrum.test.ts.
 */

/** One hourly spectral observation, as returned by src/waves/ndbc.ts. */
export interface SpectrumRecord {
  /** ISO-like UTC stamp, "YYYY-MM-DDTHH:MM". */
  time: string;
  /** Bin centre frequencies in Hz, ascending. */
  freqs: number[];
  /** Energy density per bin, m²/Hz. */
  energy: number[];
  /** Mean direction per bin, degrees from (compass). Present when hasDirection. */
  alpha1?: number[];
  /** Principal direction per bin, degrees from. */
  alpha2?: number[];
  /** First and second directional spreading coefficients, 0..1. */
  r1?: number[];
  r2?: number[];
  hasDirection: boolean;
}

export type ReconMethod = 'fourier' | 'mem';

/** S(f,θ) on a regular direction grid: values[i * nDir + j], m²/Hz/rad. */
export interface DirectionalGrid {
  values: Float64Array;
  /** Direction bin centres in degrees, 0 = from north, clockwise. */
  dirs: number[];
  nFreq: number;
  nDir: number;
}

export interface Partition {
  /** Zeroth moment (variance), m². */
  m0: number;
  sumSin: number;
  sumCos: number;
  /** Significant wave height, m. */
  hs: number;
  peakFreq: number;
  peakPeriod: number;
  /** Energy-weighted mean direction waves come from, degrees. */
  meanDir: number;
  peakDir: number;
  cells: number;
  type: 'sea' | 'swell';
}

/** Peak frequency above this is called wind sea rather than swell. */
export const SEA_SWELL_CUTOFF_HZ = 0.1;

export const deg2rad = (d: number): number => (d * Math.PI) / 180;
export const rad2deg = (r: number): number => (r * 180) / Math.PI;
export const normDeg = (d: number): number => ((d % 360) + 360) % 360;
export const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

/** Width of frequency bin i for trapezoid-style integration. */
export function freqBinWidth(freqs: number[], i: number): number {
  const n = freqs.length;
  if (n === 1) return 0.01;
  if (i === 0) return freqs[1]! - freqs[0]!;
  if (i === n - 1) return freqs[i]! - freqs[i - 1]!;
  return (freqs[i + 1]! - freqs[i - 1]!) / 2;
}

/** Hs = 4·sqrt(m0) from the 1-D spectrum. */
export function significantWaveHeight(freqs: number[], energy: number[]): number {
  let m0 = 0;
  for (let i = 0; i < freqs.length; i++) m0 += (energy[i] ?? 0) * freqBinWidth(freqs, i);
  return 4 * Math.sqrt(Math.max(m0, 0));
}

/** Frequency of the most energetic bin. */
export function peakFrequency(freqs: number[], energy: number[]): number {
  let best = 0;
  for (let i = 1; i < energy.length; i++) if ((energy[i] ?? 0) > (energy[best] ?? 0)) best = i;
  return freqs[best] ?? NaN;
}

// ---------------------------------------------------------------------------
// Directional reconstruction
// ---------------------------------------------------------------------------

/**
 * Truncated Fourier spreading function, NDBC's published method:
 *   D(θ) = 1/π · [0.5 + r1·cos(θ−α1) + r2·cos(2(θ−α2))]
 * Angles in radians. Integrates to 1 over 2π but can go negative, which
 * the caller clamps away.
 */
export function fourierDirectionFn(a1: number, a2: number, r1: number, r2: number): (theta: number) => number {
  return (th) => (1 / Math.PI) * (0.5 + r1 * Math.cos(th - a1) + r2 * Math.cos(2 * (th - a2)));
}

interface C { re: number; im: number }
const cMul = (a: C, b: C): C => ({ re: a.re * b.re - a.im * b.im, im: a.re * b.im + a.im * b.re });
const cConj = (a: C): C => ({ re: a.re, im: -a.im });
const cSub = (a: C, b: C): C => ({ re: a.re - b.re, im: a.im - b.im });
const cAbs2 = (a: C): number => a.re * a.re + a.im * a.im;

/**
 * Lygre & Krogstad (1986) maximum entropy spreading function from the same
 * four moments. Closed form: the smoothest D(θ) consistent with c1 and c2,
 * which avoids the spurious lobe the two-harmonic truncation produces for a
 * narrow peak, at the cost of over-sharpening genuinely broad seas.
 */
export function memDirectionFn(a1: number, a2: number, r1: number, r2: number): (theta: number) => number {
  // Keep |c1| away from 1: noisy buoy r1 values round to 1 and blow up phi1.
  const r1c = clamp(r1, 0, 0.999);
  const r2c = clamp(r2, 0, 0.999);
  const c1: C = { re: r1c * Math.cos(a1), im: r1c * Math.sin(a1) };
  const c2: C = { re: r2c * Math.cos(2 * a2), im: r2c * Math.sin(2 * a2) };
  const c1conj = cConj(c1);
  const c2conj = cConj(c2);

  const denom1 = 1 - cAbs2(c1);
  const c2c1 = cMul(c2, c1conj);
  const phi1: C = denom1 > 1e-6
    ? { re: (c1.re - c2c1.re) / denom1, im: (c1.im - c2c1.im) / denom1 }
    : { re: 0, im: 0 };
  const phi2 = cSub(c2, cMul(c1, phi1));
  const sigma2 = 1 - cMul(phi1, c1conj).re - cMul(phi2, c2conj).re;

  return (theta) => {
    const e1: C = { re: Math.cos(theta), im: -Math.sin(theta) };
    const e2: C = { re: Math.cos(2 * theta), im: -Math.sin(2 * theta) };
    const term = cSub(cSub({ re: 1, im: 0 }, cMul(phi1, e1)), cMul(phi2, e2));
    const denom = cAbs2(term);
    if (denom < 1e-9) return 0;
    return Math.max(sigma2, 0) / (2 * Math.PI * denom);
  };
}

/** Rebuild S(f,θ) on nDir evenly spaced direction bins. */
export function buildDirectionalSpectrum(rec: SpectrumRecord, nDir: number, method: ReconMethod): DirectionalGrid {
  const nFreq = rec.freqs.length;
  const dirs: number[] = [];
  for (let j = 0; j < nDir; j++) dirs.push((360 / nDir) * j);
  const values = new Float64Array(nFreq * nDir);
  if (!rec.hasDirection || !rec.alpha1 || !rec.alpha2 || !rec.r1 || !rec.r2) {
    return { values, dirs, nFreq, nDir };
  }

  for (let i = 0; i < nFreq; i++) {
    const E = rec.energy[i] ?? 0;
    const a1 = deg2rad(rec.alpha1[i] ?? 0);
    const a2 = deg2rad(rec.alpha2[i] ?? 0);
    const r1 = rec.r1[i] ?? 0;
    const r2 = rec.r2[i] ?? 0;
    const D = method === 'mem' ? memDirectionFn(a1, a2, r1, r2) : fourierDirectionFn(a1, a2, r1, r2);
    for (let j = 0; j < nDir; j++) {
      let s = E * D(deg2rad(dirs[j]!));
      if (!(s > 0) || !Number.isFinite(s)) s = 0;
      values[i * nDir + j] = s;
    }
  }
  return { values, dirs, nFreq, nDir };
}

/** 3×3 box smoothing, periodic in direction, clamped in frequency. */
export function smoothGrid(values: Float64Array, nFreq: number, nDir: number): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < nFreq; i++) {
    for (let j = 0; j < nDir; j++) {
      let sum = 0;
      let count = 0;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nFreq) continue;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = (((j + dj) % nDir) + nDir) % nDir;
          sum += values[ii * nDir + jj]!;
          count++;
        }
      }
      out[i * nDir + j] = sum / count;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Partitioning
// ---------------------------------------------------------------------------

/**
 * Steepest-ascent watershed: every cell follows its highest 8-neighbour up
 * to a local maximum, and all cells sharing a maximum form one wave system.
 * `smoothed` decides the catchments; `raw` is integrated for the energy so
 * smoothing does not bias Hs. Returns systems sorted by Hs, noise removed.
 */
export function partitionSpectrum(
  smoothed: Float64Array, raw: Float64Array, freqs: number[], dirs: number[], nFreq: number, nDir: number,
): Partition[] {
  const idx = (i: number, j: number): number => i * nDir + (((j % nDir) + nDir) % nDir);
  const parent = new Int32Array(nFreq * nDir);

  for (let i = 0; i < nFreq; i++) {
    for (let j = 0; j < nDir; j++) {
      let bestVal = smoothed[idx(i, j)]!;
      let bestI = i;
      let bestJ = j;
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        if (ii < 0 || ii >= nFreq) continue;
        for (let dj = -1; dj <= 1; dj++) {
          if (di === 0 && dj === 0) continue;
          const v = smoothed[idx(ii, j + dj)]!;
          if (v > bestVal) {
            bestVal = v;
            bestI = ii;
            bestJ = j + dj;
          }
        }
      }
      parent[idx(i, j)] = idx(bestI, bestJ);
    }
  }

  // Resolve chains to their root maximum, compressing paths as we go.
  const root = (start: number): number => {
    let cur = start;
    const path: number[] = [];
    while (parent[cur] !== cur) {
      path.push(cur);
      cur = parent[cur]!;
      if (path.length > nFreq * nDir) break;
    }
    for (const p of path) parent[p] = cur;
    return cur;
  };

  interface Acc { cells: number; m0: number; sumSin: number; sumCos: number; peakVal: number; peakI: number; peakJ: number }
  const groups = new Map<number, Acc>();
  const dth = deg2rad(360 / nDir);
  for (let i = 0; i < nFreq; i++) {
    const df = freqBinWidth(freqs, i);
    for (let j = 0; j < nDir; j++) {
      const k = idx(i, j);
      const lab = root(k);
      const s = raw[k]!;
      let g = groups.get(lab);
      if (!g) {
        g = { cells: 0, m0: 0, sumSin: 0, sumCos: 0, peakVal: -1, peakI: 0, peakJ: 0 };
        groups.set(lab, g);
      }
      g.m0 += s * df * dth;
      g.cells += 1;
      const th = deg2rad(dirs[j]!);
      g.sumSin += s * Math.sin(th);
      g.sumCos += s * Math.cos(th);
      if (s > g.peakVal) {
        g.peakVal = s;
        g.peakI = i;
        g.peakJ = j;
      }
    }
  }

  let partitions: Partition[] = [];
  for (const g of groups.values()) {
    const peakFreq = freqs[g.peakI]!;
    partitions.push({
      m0: g.m0,
      sumSin: g.sumSin,
      sumCos: g.sumCos,
      hs: 4 * Math.sqrt(Math.max(g.m0, 0)),
      peakFreq,
      peakPeriod: 1 / peakFreq,
      meanDir: normDeg(rad2deg(Math.atan2(g.sumSin, g.sumCos))),
      peakDir: dirs[g.peakJ]!,
      cells: g.cells,
      type: peakFreq > SEA_SWELL_CUTOFF_HZ ? 'sea' : 'swell',
    });
  }
  partitions.sort((a, b) => b.hs - a.hs);

  // Drop noise: tiny catchments and systems carrying under 1 % of the energy.
  const totalHsSq = partitions.reduce((acc, p) => acc + p.hs * p.hs, 0);
  partitions = partitions.filter((p) => p.cells >= 3 && p.hs * p.hs >= 0.01 * totalHsSq && p.hs >= 0.03);
  return partitions.slice(0, 12);
}

/** Smallest angle between two compass directions, degrees. */
export function circularDist(a: number, b: number): number {
  const d = Math.abs(normDeg(a) - normDeg(b)) % 360;
  return d > 180 ? 360 - d : d;
}

/**
 * Merge systems that are one physical wave train: close in peak frequency
 * and mean direction. The discretised two-harmonic spectrum often has two
 * neighbouring maxima where there is really one swell.
 */
export function mergeClosePartitions(partitions: Partition[], freqTol = 0.02, dirTol = 35): Partition[] {
  const merged: Partition[] = [];
  const used = new Array<boolean>(partitions.length).fill(false);

  for (let i = 0; i < partitions.length; i++) {
    if (used[i]) continue;
    let group: Partition = { ...partitions[i]! };
    used[i] = true;
    for (let j = i + 1; j < partitions.length; j++) {
      if (used[j]) continue;
      const p = partitions[j]!;
      if (Math.abs(p.peakFreq - group.peakFreq) > freqTol) continue;
      if (circularDist(p.meanDir, group.meanDir) > dirTol) continue;
      const dominant = group.hs >= p.hs ? group : p;
      const m0 = group.m0 + p.m0;
      const sumSin = group.sumSin + p.sumSin;
      const sumCos = group.sumCos + p.sumCos;
      group = {
        m0,
        sumSin,
        sumCos,
        hs: 4 * Math.sqrt(Math.max(m0, 0)),
        peakFreq: dominant.peakFreq,
        peakPeriod: 1 / dominant.peakFreq,
        meanDir: normDeg(rad2deg(Math.atan2(sumSin, sumCos))),
        peakDir: dominant.peakDir,
        cells: group.cells + p.cells,
        type: dominant.peakFreq > SEA_SWELL_CUTOFF_HZ ? 'sea' : 'swell',
      };
      used[j] = true;
    }
    merged.push(group);
  }
  merged.sort((a, b) => b.hs - a.hs);
  return merged.slice(0, 6);
}

/** Full pipeline: reconstruct, smooth twice, watershed, merge. */
export function analyseRecord(rec: SpectrumRecord, nDir: number, method: ReconMethod): { grid: DirectionalGrid; partitions: Partition[] } {
  const grid = buildDirectionalSpectrum(rec, nDir, method);
  if (!rec.hasDirection) return { grid, partitions: [] };
  let smoothed = smoothGrid(grid.values, grid.nFreq, nDir);
  smoothed = smoothGrid(smoothed, grid.nFreq, nDir); // second pass suppresses spurious maxima
  const partitions = mergeClosePartitions(
    partitionSpectrum(smoothed, grid.values, rec.freqs, grid.dirs, grid.nFreq, nDir),
  );
  return { grid, partitions };
}

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

export function compass(deg: number): string {
  return COMPASS[Math.round(normDeg(deg) / 22.5) % 16]!;
}
