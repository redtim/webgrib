import type { BinaryReader } from '../reader.js';
import type { GridDefinition, LambertConformalGrid, LatLonGrid, Section3GDS } from '../types.js';

/**
 * Section 3 — Grid Definition.
 *
 * Structure from octet 1 (section-local):
 *    1–4  length
 *    5    number (=3)
 *    6    source of grid definition
 *    7–10 number of data points
 *   11    number of octets for optional list of numbers
 *   12    interpretation of list of numbers
 *   13–14 grid definition template number
 *   15+   grid template
 *
 * We dispatch on the template number. Supported: 0 (lat/lon), 30 (Lambert Conformal).
 */
export function parseSection3(r: BinaryReader, bodyLen: number): Section3GDS {
  const start = r.pos;
  const sourceOfGridDefinition = r.uint8();
  const numberOfPoints = r.uint32();
  /* nOctListNums */ r.uint8();
  /* interpretListNums */ r.uint8();
  const template = r.uint16();

  let grid: GridDefinition;
  switch (template) {
    case 0:
      grid = parseTemplate3_0(r, numberOfPoints);
      break;
    case 30:
      grid = parseTemplate3_30(r, numberOfPoints);
      break;
    default:
      throw new Error(`Unsupported Grid Definition Template 3.${template}`);
  }

  r.pos = start + bodyLen;
  return { sourceOfGridDefinition, template, grid };
}

/**
 * Resolve "shape of earth" (code table 3.2) to a sphere radius in meters,
 * reading the scaled major/minor axes that follow as a side effect.
 *
 * Octets inside the template:
 *   shape        1 byte
 *   scaleFactorRadius    1 byte
 *   scaledValueRadius    4 bytes
 *   scaleFactorMajor     1 byte
 *   scaledValueMajor     4 bytes
 *   scaleFactorMinor     1 byte
 *   scaledValueMinor     4 bytes
 */
function readEarthShape(r: BinaryReader): { shapeOfEarth: number; earthRadius: number; majorAxis: number; minorAxis: number } {
  const shapeOfEarth = r.uint8();
  const scaleFactorRadius = r.uint8();
  const scaledValueRadius = r.uint32();
  const scaleFactorMajor = r.uint8();
  const scaledValueMajor = r.uint32();
  const scaleFactorMinor = r.uint8();
  const scaledValueMinor = r.uint32();

  // Canonical radii from the spec. When shape references a sphere, use the
  // fixed value; when it's "sphere with user-specified radius", use scaled.
  let earthRadius: number;
  switch (shapeOfEarth) {
    case 0: earthRadius = 6_367_470; break;
    case 1: earthRadius = scaledValueRadius * Math.pow(10, -scaleFactorRadius); break;
    case 2: earthRadius = 6_378_160; break;           // IAU 1965 oblate
    case 3: earthRadius = 6_371_229; break;           // user-specified oblate — approximate
    case 4: earthRadius = 6_378_137; break;           // IAG-GRS80
    case 5: earthRadius = 6_378_137; break;           // WGS84
    case 6: earthRadius = 6_371_229; break;           // GRS80 sphere
    case 8: earthRadius = 6_371_200; break;
    case 9: earthRadius = 6_378_137; break;
    default: earthRadius = 6_371_229;
  }

  const majorAxis = scaledValueMajor * Math.pow(10, -scaleFactorMajor);
  const minorAxis = scaledValueMinor * Math.pow(10, -scaleFactorMinor);
  return { shapeOfEarth, earthRadius, majorAxis, minorAxis };
}

/**
 * Grid Definition Template 3.0 — Latitude/Longitude.
 *
 * Fields after the common earth shape block:
 *    Ni  (4)   Nj  (4)
 *    basic angle (4), subdivision (4)
 *    La1 (4)   Lo1 (4)  (sign-magnitude, micro-degrees)
 *    resolution flags (1)
 *    La2 (4)   Lo2 (4)  (sign-magnitude, micro-degrees)
 *    Di  (4)   Dj  (4)  (micro-degrees)
 *    scanning mode (1)
 */
function parseTemplate3_0(r: BinaryReader, numberOfPoints: number): LatLonGrid {
  const earth = readEarthShape(r);
  const nx = r.uint32();
  const ny = r.uint32();
  const basicAngle = r.uint32();
  const subdivision = r.uint32();
  const denom = basicAngle === 0 || basicAngle === 0xffffffff ? 1_000_000 : (subdivision / (basicAngle || 1));
  const la1 = r.signedMagnitude(4) / denom;
  const lo1 = r.signedMagnitude(4) / denom;
  const resolutionAndComponentFlags = r.uint8();
  const la2 = r.signedMagnitude(4) / denom;
  const lo2 = r.signedMagnitude(4) / denom;
  const dx = r.uint32() / denom;
  const dy = r.uint32() / denom;
  const scanMode = r.uint8();

  return {
    template: 0,
    numberOfPoints,
    ...earth,
    nx, ny, la1, lo1, la2, lo2, dx, dy,
    scanMode, resolutionAndComponentFlags,
  };
}

/**
 * Grid Definition Template 3.30 — Lambert Conformal (secant/tangent).
 *
 * Fields after the earth shape block:
 *    Nx (4), Ny (4)
 *    La1 (4, sign-mag, micro-deg), Lo1 (4, sign-mag, micro-deg)
 *    resolution flags (1)
 *    LaD (4, sign-mag, micro-deg) — latitude where dx/dy specified
 *    LoV (4, sign-mag, micro-deg) — orientation longitude
 *    Dx (4) — meters, scaled by 1e-3
 *    Dy (4) — meters, scaled by 1e-3
 *    projection center flag (1)
 *    scanning mode (1)
 *    Latin1 (4, sign-mag, micro-deg)
 *    Latin2 (4, sign-mag, micro-deg)
 *    Lat of southern pole (4, sign-mag, micro-deg)
 *    Lon of southern pole (4, sign-mag, micro-deg)
 */
function parseTemplate3_30(r: BinaryReader, numberOfPoints: number): LambertConformalGrid {
  const earth = readEarthShape(r);
  const nx = r.uint32();
  const ny = r.uint32();
  const la1 = r.signedMagnitude(4) / 1_000_000;
  const lo1 = r.signedMagnitude(4) / 1_000_000;
  const resolutionAndComponentFlags = r.uint8();
  const lad = r.signedMagnitude(4) / 1_000_000;
  const lov = r.signedMagnitude(4) / 1_000_000;
  const dx = r.uint32() / 1000; // millimeters per spec
  const dy = r.uint32() / 1000;
  const projectionCenterFlag = r.uint8();
  const scanMode = r.uint8();
  const latin1 = r.signedMagnitude(4) / 1_000_000;
  const latin2 = r.signedMagnitude(4) / 1_000_000;
  const southPoleLat = r.signedMagnitude(4) / 1_000_000;
  const southPoleLon = r.signedMagnitude(4) / 1_000_000;

  return {
    template: 30,
    numberOfPoints,
    ...earth,
    nx, ny, la1, lo1, lad, lov, dx, dy,
    projectionCenterFlag, scanMode,
    latin1, latin2, southPoleLat, southPoleLon,
    resolutionAndComponentFlags,
  };
}
