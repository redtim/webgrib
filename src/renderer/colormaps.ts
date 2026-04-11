/**
 * Colormap LUTs for scalar field rendering. Each map is a 256-entry RGBA
 * byte array — simple, tiny, good enough for a fragment-shader 1D lookup.
 *
 * Maps are lazily built so the module has no side effects at import time.
 */

export type ColormapName = 'viridis' | 'turbo' | 'inferno' | 'grayscale' | 'temperature';

export function colormap(name: ColormapName): Uint8Array {
  switch (name) {
    case 'viridis': return buildFromStops(VIRIDIS_STOPS);
    case 'turbo': return buildFromStops(TURBO_STOPS);
    case 'inferno': return buildFromStops(INFERNO_STOPS);
    case 'grayscale': return buildFromStops([[0, 0, 0], [255, 255, 255]]);
    case 'temperature': return buildFromStops(TEMP_STOPS);
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
