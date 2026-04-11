/**
 * Structured representation of a parsed GRIB2 message. All fields are parsed
 * eagerly except Section 7 (data), which is kept as a raw byte slice and
 * decoded on demand via unpack().
 */

export interface Section0 {
  discipline: number;     // octet 7 — code table 0.0
  edition: number;        // octet 8 — must be 2
  totalLength: number;    // octets 9–16 — total bytes in this message
}

export interface Section1 {
  originatingCenter: number;
  originatingSubCenter: number;
  masterTablesVersion: number;
  localTablesVersion: number;
  significanceOfReferenceTime: number;
  referenceTime: { year: number; month: number; day: number; hour: number; minute: number; second: number };
  productionStatus: number;
  typeOfProcessedData: number;
}

/** Union of supported grid definition templates. */
export type GridDefinition =
  | LatLonGrid
  | LambertConformalGrid;

export interface GridCommon {
  numberOfPoints: number;
  shapeOfEarth: number;
  earthRadius: number;      // meters — filled from shapeOfEarth if spheroidal
  majorAxis: number;
  minorAxis: number;
}

export interface LatLonGrid extends GridCommon {
  template: 0;
  nx: number;                // Ni — points along parallel
  ny: number;                // Nj — points along meridian
  la1: number; lo1: number;  // degrees
  la2: number; lo2: number;  // degrees
  dx: number; dy: number;    // degrees
  scanMode: number;          // flag table 3.4
  resolutionAndComponentFlags: number;
}

export interface LambertConformalGrid extends GridCommon {
  template: 30;
  nx: number;
  ny: number;
  la1: number; lo1: number;  // degrees — first grid point
  lad: number;               // degrees — latitude where dx/dy true
  lov: number;               // degrees — orientation longitude (central meridian)
  dx: number; dy: number;    // meters
  projectionCenterFlag: number;
  scanMode: number;
  latin1: number;            // degrees — first standard parallel
  latin2: number;            // degrees — second standard parallel
  southPoleLat: number;
  southPoleLon: number;
  resolutionAndComponentFlags: number;
}

export interface Section4 {
  nCoordinateValues: number;
  template: number;          // 4.0 is the common case: analysis/forecast at a level
  /** Parameter category — code table 4.1, indexed by discipline. */
  parameterCategory: number;
  /** Parameter number — code table 4.2. */
  parameterNumber: number;
  typeOfGeneratingProcess: number;
  /** Forecast time with units (code table 4.4). */
  forecastTime: number;
  indicatorOfUnitOfTimeRange: number;
  typeOfFirstFixedSurface: number;
  scaleFactorOfFirstFixedSurface: number;
  scaledValueOfFirstFixedSurface: number;
  typeOfSecondFixedSurface: number;
  scaleFactorOfSecondFixedSurface: number;
  scaledValueOfSecondFixedSurface: number;
}

export interface Section5 {
  numberOfValues: number;
  template: number;
  /** Raw Section 5 body after octet 10, used by DRS template parsers. */
  body: Uint8Array;
}

export interface Section6 {
  bitmapIndicator: number;   // 0 = present, 254 = previously defined, 255 = no bitmap
  bitmap: Uint8Array | null; // only when bitmapIndicator === 0
}

export interface Section3GDS {
  sourceOfGridDefinition: number;
  template: number;
  grid: GridDefinition;
}

export interface Section7 {
  data: Uint8Array;          // raw packed bytes, to be handed to a DRS template decoder
}

/** One message, post-parse but pre-unpack. */
export interface GribMessage {
  byteOffset: number;
  byteLength: number;
  section0: Section0;
  section1: Section1;
  section3: Section3GDS;
  section4: Section4;
  section5: Section5;
  section6: Section6;
  section7: Section7;
}

/** Decoded values on the native grid, in scan order. */
export interface DecodedField {
  values: Float32Array;
  nx: number;
  ny: number;
  missingValue: number;
  min: number;
  max: number;
}
