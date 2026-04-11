import type { BinaryReader } from '../reader.js';
import type { Section6 } from '../types.js';

/**
 * Section 6 — Bitmap. One byte indicator:
 *   0   — bitmap follows, 1 bit per grid point (1=present, 0=missing)
 *   1–253 — predefined bitmap (we don't support these)
 *   254 — reuse previous bitmap in this message (we don't currently track state)
 *   255 — no bitmap (all points present)
 */
export function parseSection6(r: BinaryReader, bodyLen: number): Section6 {
  const start = r.pos;
  const bitmapIndicator = r.uint8();
  let bitmap: Uint8Array | null = null;
  if (bitmapIndicator === 0) {
    bitmap = r.slice(bodyLen - 1);
  } else {
    r.pos = start + bodyLen;
  }
  return { bitmapIndicator, bitmap };
}
