/** Display products and their colour tables. */

export type ProductId = 'REF' | 'VEL';

type Stop = [value: number, r: number, g: number, b: number];

export interface Product {
  label: string;
  unit: string;
  /** Value range spanned by the lookup table. */
  min: number;
  max: number;
  /** Banded tables hold each colour until the next stop; others blend. */
  banded: boolean;
  /** Values below the first stop are transparent when banded. */
  stops: Stop[];
}

export const RANGE_FOLDED_COLOR: [number, number, number] = [124, 0, 160];

export const PRODUCTS: Record<ProductId, Product> = {
  REF: {
    label: 'Reflectivity',
    unit: 'dBZ',
    min: -32,
    max: 96,
    banded: true,
    stops: [
      [-10, 62, 66, 78], [0, 98, 104, 118], [5, 64, 150, 160], [10, 1, 159, 244], [15, 3, 0, 244],
      [20, 2, 253, 2], [25, 1, 197, 1], [30, 0, 142, 0], [35, 253, 248, 2], [40, 229, 188, 0],
      [45, 253, 149, 0], [50, 253, 0, 0], [55, 212, 0, 0], [60, 188, 0, 0], [65, 248, 0, 253],
      [70, 152, 84, 198], [75, 253, 253, 253],
    ],
  },
  VEL: {
    label: 'Velocity',
    unit: 'm/s',
    min: -64,
    max: 64,
    banded: false,
    // Negative is toward the radar.
    stops: [
      [-64, 255, 0, 150], [-45, 0, 255, 255], [-30, 0, 255, 0], [-10, 0, 140, 0], [-1, 80, 120, 80],
      [0, 125, 125, 125],
      [1, 125, 85, 85], [10, 140, 0, 0], [30, 255, 0, 0], [45, 255, 170, 60], [64, 255, 255, 120],
    ],
  },
};

/** 256 RGBA entries; entry i starts at min + i × (max − min) / 256. */
export function buildLut({ min, max, banded, stops }: Product): Uint8Array {
  const lut = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const value = min + (i * (max - min)) / 256;
    let below = -1;
    while (below + 1 < stops.length && stops[below + 1]![0] <= value) below++;
    if (below < 0 && banded) continue;
    const a = stops[Math.max(below, 0)]!;
    const b = stops[Math.min(below + 1, stops.length - 1)]!;
    const t = banded || a === b || below < 0 ? 0 : (value - a[0]) / (b[0] - a[0]);
    for (let c = 1; c <= 3; c++) lut[i * 4 + c - 1] = Math.round(a[c]! + t * (b[c]! - a[c]!));
    lut[i * 4 + 3] = 255;
  }
  return lut;
}
