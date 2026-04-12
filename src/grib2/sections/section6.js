/**
 * Section 6 — Bitmap. One byte indicator:
 *   0   — bitmap follows, 1 bit per grid point (1=present, 0=missing)
 *   1–253 — predefined bitmap (we don't support these)
 *   254 — reuse previous bitmap in this message (we don't currently track state)
 *   255 — no bitmap (all points present)
 */
export function parseSection6(r, bodyLen) {
    const start = r.pos;
    const bitmapIndicator = r.uint8();
    let bitmap = null;
    if (bitmapIndicator === 0) {
        bitmap = r.slice(bodyLen - 1);
    }
    else {
        r.pos = start + bodyLen;
    }
    return { bitmapIndicator, bitmap };
}
