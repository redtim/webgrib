/**
 * Colormap LUTs for scalar field rendering. Each map is a 256-entry RGBA
 * byte array — simple, tiny, good enough for a fragment-shader 1D lookup.
 *
 * Maps are lazily built so the module has no side effects at import time.
 */

export type ColormapName =
  | 'viridis' | 'turbo' | 'inferno' | 'grayscale'
  | 'temperature' | 'wind'
  | 'precipitation' | 'humidity' | 'cape' | 'cin' | 'cloud' | 'snow'
  | 'lightning';

export function colormap(name: ColormapName): Uint8Array {
  switch (name) {
    case 'viridis': {
      const lut = buildFromStops(VIRIDIS_STOPS);
      lut[3] = 0; // index 0 (lowest value) = fully transparent
      return lut;
    }
    case 'turbo': {
      const lut = buildFromStops(TURBO_STOPS);
      lut[3] = 0; // index 0 (lowest value) = fully transparent
      return lut;
    }
    case 'inferno': return buildFromStops(INFERNO_STOPS);
    case 'grayscale': return buildFromStops([[0, 0, 0], [255, 255, 255]]);
    case 'temperature': return buildFromStops(TEMP_STOPS);
    case 'wind': return buildFromStops(WIND_STOPS);
    case 'precipitation': {
      const lut = buildFromStops(PRECIP_STOPS);
      lut[3] = 0; // index 0 (value 0.0) = fully transparent
      return lut;
    }
    case 'humidity': return buildFromStops(HUMIDITY_STOPS);
    case 'cape': {
      const lut = buildFromStops(CAPE_STOPS);
      lut[3] = 0; // index 0 (value 0) = fully transparent
      return lut;
    }
    case 'cin': {
      const lut = buildFromStops(CAPE_STOPS);
      lut[255 * 4 + 3] = 0; // index 255 (value 0) = fully transparent
      return lut;
    }
    case 'cloud': return buildFromStops(CLOUD_STOPS);
    case 'snow': return buildFromStops(SNOW_STOPS);
    case 'lightning': {
      const lut = buildFromStops(LIGHTNING_STOPS);
      lut[3] = 0; // index 0 (value 0.0) = fully transparent
      return lut;
    }
  }
}

function buildFromStops(stops: Array<[number, number, number]>): Uint8Array {
  const n = 256;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    const seg = t * (stops.length - 1);
    const iSeg = Math.min(stops.length - 2, Math.floor(seg));
    const f = seg - iSeg;
    const a = stops[iSeg]!;
    const b = stops[iSeg + 1]!;
    out[i * 4 + 0] = Math.round(a[0] + (b[0] - a[0]) * f);
    out[i * 4 + 1] = Math.round(a[1] + (b[1] - a[1]) * f);
    out[i * 4 + 2] = Math.round(a[2] + (b[2] - a[2]) * f);
    out[i * 4 + 3] = 255;
  }
  return out;
}

// Coarse key stops sampled from matplotlib palettes. Good enough for a LUT.
const VIRIDIS_STOPS: Array<[number, number, number]> = [
  [68, 1, 84], [72, 35, 116], [64, 67, 135], [52, 94, 141], [41, 120, 142],
  [32, 144, 140], [34, 167, 132], [68, 190, 112], [121, 209, 81], [189, 222, 38], [253, 231, 36],
];
const TURBO_STOPS: Array<[number, number, number]> = [
  [48, 18, 59], [70, 107, 227], [39, 206, 233], [82, 255, 109],
  [222, 242, 44], [252, 154, 36], [232, 47, 16], [122, 4, 3],
];
const INFERNO_STOPS: Array<[number, number, number]> = [
  [0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106],
  [186, 54, 85], [227, 89, 51], [249, 140, 10], [252, 198, 38], [252, 255, 164],
];
const TEMP_STOPS: Array<[number, number, number]> = [
  [15, 15, 85], [30, 60, 180], [90, 150, 230], [190, 220, 240],
  [255, 240, 180], [255, 180, 80], [210, 70, 30], [120, 0, 0],
];
// Windy.com-style wind palette: dark indigo at calm, through blue / teal /
// green / yellow / orange / red to a deep maroon for extreme winds. Stops
// are evenly spaced — `buildFromStops` interpolates between them — and the
// consumer picks the value range via `uValueRange` (e.g. 0–30 m/s).
const WIND_STOPS: Array<[number, number, number]> = [
  [37, 4, 82],      // deep violet — calm
  [42, 42, 132],    // indigo
  [52, 86, 178],    // royal blue
  [60, 138, 198],   // light blue
  [62, 178, 172],   // teal / cyan
  [76, 188, 108],   // green
  [148, 208, 60],   // yellow-green
  [232, 220, 52],   // yellow
  [240, 158, 40],   // orange
  [220, 72, 32],    // red
  [150, 22, 22],    // dark red
  [92, 18, 36],     // maroon — extreme
];
// Precipitation: white → green → yellow → orange → red → magenta
const PRECIP_STOPS: Array<[number, number, number]> = [
  [240, 240, 240], [200, 230, 200], [120, 200, 120], [60, 180, 60],
  [220, 220, 50], [240, 160, 30], [220, 60, 30], [180, 30, 100], [130, 20, 140],
];
// Humidity: tan → green → teal → blue
const HUMIDITY_STOPS: Array<[number, number, number]> = [
  [200, 180, 140], [160, 190, 110], [80, 180, 80],
  [50, 170, 150], [40, 130, 180], [30, 80, 170],
];
// CAPE: white → yellow → orange → red → magenta → purple
const CAPE_STOPS: Array<[number, number, number]> = [
  [240, 240, 240], [255, 255, 150], [255, 220, 80],
  [255, 140, 40], [230, 50, 30], [200, 30, 120], [120, 20, 160],
];
// Cloud cover: transparent-ish light gray → opaque white
const CLOUD_STOPS: Array<[number, number, number]> = [
  [30, 30, 40], [80, 85, 95], [140, 145, 155],
  [190, 195, 200], [230, 233, 238],
];
// Snow: light blue → blue → purple
const SNOW_STOPS: Array<[number, number, number]> = [
  [220, 235, 250], [170, 210, 240], [100, 170, 220],
  [60, 120, 200], [80, 60, 180], [100, 30, 150],
];
// Lightning threat: dark purple → magenta → orange → yellow → white.
// Index 0 is set to alpha=0 after building so value 0.0 is transparent.
const LIGHTNING_STOPS: Array<[number, number, number]> = [
  [40, 10, 60], [80, 40, 120], [180, 60, 180],
  [255, 160, 40], [255, 240, 80], [255, 255, 255],
];
