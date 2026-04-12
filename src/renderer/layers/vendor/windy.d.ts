/**
 * Type declarations for the vendored `windy.js` particle renderer (see
 * `./windy.js` for the full source and patch notes). Only the surface we
 * actually call from the TypeScript host is modeled here.
 */

/** One u- or v-component record in windy.js's input payload. */
export interface WindyComponentHeader {
  parameterCategory: number;
  parameterNumber: number;
  lo1: number;
  la1: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  refTime: string;
  forecastTime: number;
  /** GRIB2 flag table 3.4. Omit or pass 0 for the standard NW-origin layout. */
  scanMode?: number;
  /** Optional — windy.js rejects anything that isn't template 0 (lat/lon). */
  gridDefinitionTemplate?: number;
}

export interface WindyComponent {
  header: WindyComponentHeader;
  /** Flat row-major array, length nx * ny. Row 0 is the northernmost. */
  data: ArrayLike<number>;
}

export interface WindyParams {
  canvas: HTMLCanvasElement;
  data: WindyComponent[];
  /** Pixel-coord → [lon, lat] in degrees. */
  invert: (x: number, y: number) => [number, number];
  /** (lat, lon) in degrees → pixel coord. */
  project: (lat: number, lon: number) => [number, number];
  minVelocity?: number;
  maxVelocity?: number;
  velocityScale?: number;
  particleAge?: number;
  lineWidth?: number;
  particleMultiplier?: number;
  frameRate?: number;
  colorScale?: string[];
}

export interface WindyOptions {
  minVelocity?: number;
  maxVelocity?: number;
  velocityScale?: number;
  particleAge?: number;
  lineWidth?: number;
  particleMultiplier?: number;
  opacity?: number;
  frameRate?: number;
}

export interface WindyInstance {
  params: WindyParams;
  /** `bounds = [[x0, y0], [x1, y1]]` in canvas pixels, `extent = [[west, south], [east, north]]` in degrees. */
  start: (
    bounds: [[number, number], [number, number]],
    width: number,
    height: number,
    extent: [[number, number], [number, number]],
  ) => void;
  stop: () => void;
  setData: (data: WindyComponent[]) => void;
  setOptions: (options: WindyOptions) => void;
  /** Populated after `start()` completes its async interpolation pass. */
  field?: unknown;
}

declare const Windy: (params: WindyParams) => WindyInstance;
export default Windy;
