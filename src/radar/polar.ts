/**
 * Rearranges a sweep's radials into a regular azimuth × range grid that a
 * shader can index directly.
 */

import { gateValue, type Codes, type Moment, type Sweep, type Volume } from './level2.js';

const EARTH_RADIUS = 6_371_000;

export interface PolarGrid {
  /** Rows; row i covers azimuths [i, i+1) × 360/azimuthBins degrees. */
  azimuthBins: number;
  gateCount: number;
  /** Metres along the beam to the centre of the first gate. */
  firstGate: number;
  gateSpacing: number;
  /** Beam elevation, degrees. */
  elevation: number;
  /** Coding of the gates; see `gateValue` in level2. */
  scale: number;
  offset: number;
  /** Row-major [azimuth][gate] codes; 0 where there is no data. */
  data: Codes;
}

export function lowestSweepWith(volume: Volume, moment: string): Sweep | undefined {
  return volume.sweeps
    .filter((s) => s.radials.some((r) => moment in r.moments))
    .sort((a, b) => a.elevationNumber - b.elevationNumber)[0];
}

export function buildPolarGrid(sweep: Sweep, moment: string): PolarGrid | undefined {
  const radials = sweep.radials.filter((r) => moment in r.moments);
  const first = radials[0]?.moments[moment];
  if (!first) return undefined;

  const spacing = sweep.azimuthSpacing;
  const azimuthBins = Math.round(360 / spacing);
  const gateCount = radials.reduce((n, r) => Math.max(n, r.moments[moment]!.codes.length), 0);
  const data = new (first.codes instanceof Uint8Array ? Uint8Array : Uint16Array)(azimuthBins * gateCount);

  // Each row takes the radial nearest its centre, if one is within a spacing.
  // Radials only land near their nominal azimuths, so binning them directly
  // would leave empty seams.
  const nearest = new Int32Array(azimuthBins).fill(-1);
  const distance = new Float64Array(azimuthBins).fill(spacing);
  radials.forEach((radial, index) => {
    const home = Math.floor(radial.azimuth / spacing);
    for (let step = -1; step <= 1; step++) {
      const row = (((home + step) % azimuthBins) + azimuthBins) % azimuthBins;
      const delta = Math.abs(((((radial.azimuth - (row + 0.5) * spacing) % 360) + 540) % 360) - 180);
      if (delta < distance[row]!) {
        distance[row] = delta;
        nearest[row] = index;
      }
    }
  });
  nearest.forEach((index, row) => {
    if (index >= 0) data.set(codedLike(radials[index]!.moments[moment]!, first), row * gateCount);
  });

  return {
    azimuthBins,
    gateCount,
    firstGate: first.firstGate,
    gateSpacing: first.gateSpacing,
    elevation: sweep.elevation,
    scale: first.scale,
    offset: first.offset,
    data,
  };
}

/** A moment's codes expressed in another moment's coding. */
function codedLike(moment: Moment, target: Moment): Codes {
  const wide = target.codes instanceof Uint16Array;
  if (moment.scale === target.scale && moment.offset === target.offset && wide === moment.codes instanceof Uint16Array) {
    return moment.codes;
  }
  const largest = wide ? 0xffff : 0xff;
  const out = new (wide ? Uint16Array : Uint8Array)(moment.codes.length);
  moment.codes.forEach((code, i) => {
    if (code <= 1) {
      out[i] = code;
      return;
    }
    const value = gateValue(code, moment.scale, moment.offset);
    const recoded = target.scale === 0 ? value : value * target.scale + target.offset;
    out[i] = Math.max(2, Math.min(largest, Math.round(recoded)));
  });
  return out;
}

/**
 * Box enclosing every point within `radius` metres of the radar, as
 * [west, north, east, south] in the Web Mercator unit square.
 */
export function coverageQuad(latitude: number, longitude: number, radius: number): [number, number, number, number] {
  const rad = Math.PI / 180;
  const arc = radius / EARTH_RADIUS;
  const dLat = arc / rad;
  const dLon = Math.asin(Math.min(1, Math.sin(arc) / Math.cos(latitude * rad))) / rad;
  const x = (lon: number) => (lon + 180) / 360;
  const y = (lat: number) => (1 - Math.asinh(Math.tan(lat * rad)) / Math.PI) / 2;
  return [x(longitude - dLon), y(latitude + dLat), x(longitude + dLon), y(latitude - dLat)];
}
