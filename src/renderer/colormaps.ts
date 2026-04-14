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
  | 'lightning'
  | 'ocean-currents'
  | 'water-level'
  | 'bathymetry';

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
    case 'temperature': return buildFromPositionedStops(TEMP_STOPS);
    case 'wind': return buildFromPositionedStops(WIND_STOPS);
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
    case 'ocean-currents': {
      const lut = buildFromStops(OCEAN_CURRENT_STOPS);
      lut[3] = 0; // index 0 (no current) = fully transparent
      return lut;
    }
    case 'water-level': return buildFromStops(WATER_LEVEL_STOPS);
    case 'bathymetry': {
      const lut = buildFromPositionedStops(BATHYMETRY_STOPS);
      lut[3] = 0; // index 0 (zero depth / dry) = fully transparent
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

/** Like buildFromStops but each stop carries an explicit position (0–1). */
function buildFromPositionedStops(
  stops: Array<{ t: number; rgb: [number, number, number] }>,
): Uint8Array {
  const n = 256;
  const out = new Uint8Array(n * 4);
  for (let i = 0; i < n; i++) {
    const t = i / (n - 1);
    // Find the segment this t falls into
    let s = 0;
    while (s < stops.length - 2 && stops[s + 1]!.t < t) s++;
    const a = stops[s]!;
    const b = stops[s + 1]!;
    const span = b.t - a.t;
    const f = span > 0 ? (t - a.t) / span : 0;
    out[i * 4 + 0] = Math.round(a.rgb[0] + (b.rgb[0] - a.rgb[0]) * f);
    out[i * 4 + 1] = Math.round(a.rgb[1] + (b.rgb[1] - a.rgb[1]) * f);
    out[i * 4 + 2] = Math.round(a.rgb[2] + (b.rgb[2] - a.rgb[2]) * f);
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
// Temperature palette — exact RGB stops keyed by Kelvin.
const TEMP_MIN_K = 203;
const TEMP_MAX_K = 320;
const TEMP_STOPS: Array<{ t: number; rgb: [number, number, number] }> = [
  { t: (203    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [115, 70, 105] },  // 203 K = -70°C
  { t: (218    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [202, 172, 195] }, // 218 K = -55°C
  { t: (233    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [162, 70, 145] },  // 233 K = -40°C
  { t: (248    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [143, 89, 169] },  // 248 K = -25°C
  { t: (258    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [157, 219, 217] }, // 258 K = -15°C
  { t: (265    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [106, 191, 181] }, // 265 K =  -8°C
  { t: (269    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [100, 166, 189] }, // 269 K =  -4°C
  { t: (273.15 - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [93, 133, 198] },  // 273 K =   0°C
  { t: (274    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [68, 125, 99] },   // 274 K =   1°C
  { t: (283    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [128, 147, 24] },  // 283 K =  10°C
  { t: (294    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [243, 183, 4] },   // 294 K =  21°C
  { t: (303    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [232, 83, 25] },   // 303 K =  30°C
  { t: (320    - TEMP_MIN_K) / (TEMP_MAX_K - TEMP_MIN_K), rgb: [71, 14, 0] },     // 320 K =  47°C
];
// Wind palette — 0–35 kt (0–18 m/s). Exact RGB values sampled from reference image.
const KT = 0.514444; // 1 knot in m/s
const WIND_MAX_MS = 35 * KT; // 18.006 m/s
const WIND_STOPS: Array<{ t: number; rgb: [number, number, number] }> = [
  { t:  0 * KT / WIND_MAX_MS, rgb: [255, 255, 255] },  //  0 kt
  { t:  2 * KT / WIND_MAX_MS, rgb: [203, 203, 251] },  //  2 kt
  { t:  3 * KT / WIND_MAX_MS, rgb: [203, 203, 251] },  //  3 kt
  { t:  5 * KT / WIND_MAX_MS, rgb: [217, 251, 250] },  //  5 kt
  { t:  7 * KT / WIND_MAX_MS, rgb: [161, 245, 208] },  //  7 kt
  { t:  9 * KT / WIND_MAX_MS, rgb: [121, 249, 112] },  //  9 kt
  { t: 10 * KT / WIND_MAX_MS, rgb: [121, 249, 112] },  // 10 kt
  { t: 12 * KT / WIND_MAX_MS, rgb: [117, 251,  76] },  // 12 kt
  { t: 14 * KT / WIND_MAX_MS, rgb: [215, 242,  78] },  // 14 kt
  { t: 16 * KT / WIND_MAX_MS, rgb: [247, 204,  71] },  // 16 kt
  { t: 17 * KT / WIND_MAX_MS, rgb: [247, 204,  71] },  // 17 kt
  { t: 19 * KT / WIND_MAX_MS, rgb: [241, 155,  61] },  // 19 kt
  { t: 21 * KT / WIND_MAX_MS, rgb: [235,  79,  45] },  // 21 kt
  { t: 23 * KT / WIND_MAX_MS, rgb: [116,  20,  11] },  // 23 kt
  { t: 24 * KT / WIND_MAX_MS, rgb: [116,  20,  11] },  // 24 kt
  { t: 26 * KT / WIND_MAX_MS, rgb: [134,  25,  25] },  // 26 kt
  { t: 28 * KT / WIND_MAX_MS, rgb: [166,  33,  61] },  // 28 kt
  { t: 30 * KT / WIND_MAX_MS, rgb: [188,  39,  96] },  // 30 kt
  { t: 31 * KT / WIND_MAX_MS, rgb: [188,  39,  96] },  // 31 kt
  { t: 33 * KT / WIND_MAX_MS, rgb: [206,  44, 130] },  // 33 kt
  { t: 35 * KT / WIND_MAX_MS, rgb: [206,  44, 168] },  // 35 kt
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
// Ocean currents: dark blue (calm) → teal → green → yellow → orange (fast)
const OCEAN_CURRENT_STOPS: Array<[number, number, number]> = [
  [10, 20, 80], [20, 60, 140], [30, 120, 160],
  [40, 180, 140], [100, 200, 80], [200, 220, 50],
  [240, 180, 40], [255, 120, 30],
];
// Water-level anomaly (diverging around 0): deep blue (ebb) → white → deep red (flood)
const WATER_LEVEL_STOPS: Array<[number, number, number]> = [
  [15, 40, 120], [60, 110, 180], [150, 190, 230],
  [245, 245, 245],
  [250, 180, 140], [220, 90, 70], [130, 20, 30],
];
// Bathymetric depth over a 0–100 m value range with nonlinear resolution.
// Every 0.5 ft (0.1524 m) gets its own color stop between 0–3 m, using a
// red → orange → yellow → green → teal ramp — matches nautical-chart
// intuition where shoal water (danger) is warm and deeper water cools off.
// Above 3 m the palette spreads through blues to navy at 100 m.
//
// Stop positions are expressed as depth_m / 100 so the renderer's
// scalar range should be [0, 100] m.
const BATHYMETRY_STOPS: Array<{ t: number; rgb: [number, number, number] }> = [
  // Dry / edge (made fully transparent by lut[3]=0 after build).
  { t: 0.0000, rgb: [255, 255, 255] },
  // Danger zone (0–2 ft): deep reds.
  { t: 0.001524, rgb: [120,   0,  20] }, // 0.5 ft
  { t: 0.003048, rgb: [170,  20,  25] }, // 1.0 ft
  { t: 0.004572, rgb: [210,  40,  30] }, // 1.5 ft
  { t: 0.006096, rgb: [235,  70,  35] }, // 2.0 ft
  // Caution (2–4 ft): oranges.
  { t: 0.00762,  rgb: [245, 110,  40] }, // 2.5 ft
  { t: 0.009144, rgb: [250, 140,  50] }, // 3.0 ft
  { t: 0.010668, rgb: [252, 170,  60] }, // 3.5 ft
  { t: 0.012192, rgb: [253, 195,  75] }, // 4.0 ft
  // Shallow nav (4–6 ft): yellows.
  { t: 0.013716, rgb: [253, 220,  90] }, // 4.5 ft
  { t: 0.01524,  rgb: [250, 240, 110] }, // 5.0 ft
  { t: 0.016764, rgb: [225, 235, 110] }, // 5.5 ft
  { t: 0.018288, rgb: [190, 225, 110] }, // 6.0 ft — NOAA 6 ft safety line
  // Safe shallow (6–8 ft): greens.
  { t: 0.019812, rgb: [150, 215, 115] }, // 6.5 ft
  { t: 0.021336, rgb: [110, 200, 125] }, // 7.0 ft
  { t: 0.02286,  rgb: [ 80, 190, 140] }, // 7.5 ft
  { t: 0.024384, rgb: [ 60, 180, 160] }, // 8.0 ft
  // Transition to teal (8–10 ft).
  { t: 0.025908, rgb: [ 50, 175, 180] }, // 8.5 ft
  { t: 0.027432, rgb: [ 50, 170, 200] }, // 9.0 ft
  { t: 0.028956, rgb: [ 55, 165, 215] }, // 9.5 ft
  { t: 0.03048,  rgb: [ 70, 160, 225] }, // 10.0 ft  (≈ 3 m)
  // 3–100 m: spread through blues to navy.
  { t: 0.05,    rgb: [ 60, 135, 210] }, //   5 m
  { t: 0.10,    rgb: [ 45, 110, 190] }, //  10 m
  { t: 0.20,    rgb: [ 35,  85, 165] }, //  20 m
  { t: 0.35,    rgb: [ 25,  60, 135] }, //  35 m
  { t: 0.55,    rgb: [ 15,  40, 100] }, //  55 m
  { t: 0.75,    rgb: [ 10,  25,  75] }, //  75 m
  { t: 1.00,    rgb: [  5,  10,  40] }, // 100 m
];
