/**
 * Data Representation Template 5.41 — grid point data with PNG compression.
 *
 * The packed values are embedded as a single PNG image. PNG sample depth
 * corresponds to `bitsPerValue`:
 *   8 bits  → 8-bit grayscale
 *   16 bits → 16-bit grayscale (big-endian samples, which matches PNG native)
 *   24 bits → RGB (the three channels concatenated as one 24-bit sample)
 *   32 bits → RGBA
 *
 * We decode with the browser's native image pipeline via `createImageBitmap`
 * and a scratch `OffscreenCanvas`, then apply the R/E/D transform and any
 * bitmap. On Node, the caller can supply a PNG decoder via
 * {@link setPngDecoder}; the default throws if the browser APIs are absent.
 */

import type { Section5, Section6, Section7 } from '../../types.js';
import { applyBitmap, parseSimplePackingHeader } from './common.js';

/** Abstract decoder so we can swap in `pngjs` or similar on Node. */
export interface PngDecoded {
  width: number;
  height: number;
  /** Samples in row-major order, one number per *pixel* (not per channel). */
  samples: Uint32Array;
}

type PngDecoder = (bytes: Uint8Array, bitsPerValue: number) => Promise<PngDecoded>;

let customDecoder: PngDecoder | null = null;
export function setPngDecoder(decoder: PngDecoder | null): void {
  customDecoder = decoder;
}

async function defaultBrowserDecode(bytes: Uint8Array, bitsPerValue: number): Promise<PngDecoded> {
  if (typeof createImageBitmap === 'undefined' || typeof OffscreenCanvas === 'undefined') {
    throw new Error('PNG decoder unavailable: no createImageBitmap/OffscreenCanvas. Call setPngDecoder() with a polyfill.');
  }
  // Copy into a fresh ArrayBuffer-backed Uint8Array so the Blob ctor is happy
  // with lib.dom's stricter SharedArrayBuffer-aware BlobPart type.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const blob = new Blob([copy], { type: 'image/png' });
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  const rgba = img.data;
  const n = bmp.width * bmp.height;
  const samples = new Uint32Array(n);

  // Canvas collapses 16-bit PNGs to 8-bit. For GRIB2's common case of nbits ≤ 8,
  // that's fine — we take R. For wider samples, the caller must supply a real
  // PNG decoder via setPngDecoder().
  switch (bitsPerValue) {
    case 8:
      for (let i = 0; i < n; i++) samples[i] = rgba[i * 4]!;
      break;
    case 24:
      for (let i = 0; i < n; i++) {
        samples[i] = (rgba[i * 4]! << 16) | (rgba[i * 4 + 1]! << 8) | rgba[i * 4 + 2]!;
      }
      break;
    case 32:
      for (let i = 0; i < n; i++) {
        samples[i] = ((rgba[i * 4]! << 24) | (rgba[i * 4 + 1]! << 16) | (rgba[i * 4 + 2]! << 8) | rgba[i * 4 + 3]!) >>> 0;
      }
      break;
    case 16:
      // Browsers collapse 16-bit PNGs to 8-bit in canvas. We fall back to the
      // 8-bit channel; this will undercount precision. Projects that need full
      // 16-bit PNG-packed GRIB2 should supply a native decoder via
      // setPngDecoder().
      for (let i = 0; i < n; i++) samples[i] = rgba[i * 4]!;
      break;
    default:
      throw new Error(`PNG-packed GRIB2 with ${bitsPerValue} bits per value is not supported by the default decoder`);
  }
  return { width: bmp.width, height: bmp.height, samples };
}

export async function unpackPng(
  s5: Section5,
  s6: Section6,
  s7: Section7,
  totalPoints: number,
): Promise<Float32Array> {
  const header = parseSimplePackingHeader(s5.body);
  const count = s5.numberOfValues;
  const decode = customDecoder ?? defaultBrowserDecode;
  const { samples } = await decode(s7.data, header.bitsPerValue);

  const twoE = Math.pow(2, header.binaryScale);
  const tenD = Math.pow(10, -header.decimalScale);
  const dense = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    dense[i] = (header.referenceValue + (samples[i] ?? 0) * twoE) * tenD;
  }

  if (s6.bitmapIndicator === 0 && s6.bitmap) {
    return applyBitmap(dense, s6.bitmap, count);
  }
  if (dense.length !== totalPoints) {
    const full = new Float32Array(totalPoints);
    full.set(dense.subarray(0, Math.min(dense.length, totalPoints)));
    return full;
  }
  return dense;
}
