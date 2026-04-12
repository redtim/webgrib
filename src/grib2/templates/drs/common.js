/**
 * IEEE 754 single-precision float decoded from a 4-byte big-endian buffer.
 * GRIB2 reference values in DRS headers are IEEE floats.
 */
export function ieeeFloat32(buf, offset) {
    const view = new DataView(buf.buffer, buf.byteOffset + offset, 4);
    return view.getFloat32(0, false);
}
/**
 * Parse the 11-byte simple-packing header that begins data representation
 * templates 5.0, 5.2, 5.3, 5.40, and 5.41.
 *
 * Offsets (section-local, starting where §5 body begins after the template
 * number was read):
 *   0..3  R (IEEE float32)
 *   4..5  E (int16, sign-magnitude in spec but practical impls use two's comp)
 *   6..7  D (int16)
 *   8     number of bits per value
 *   9     type of original field values
 */
export function parseSimplePackingHeader(body, offset = 0) {
    const referenceValue = ieeeFloat32(body, offset + 0);
    // E and D are sign-magnitude per spec. Decode the high-bit as sign.
    const ebRaw = (body[offset + 4] << 8) | body[offset + 5];
    const binaryScale = (ebRaw & 0x8000) ? -(ebRaw & 0x7fff) : ebRaw;
    const dbRaw = (body[offset + 6] << 8) | body[offset + 7];
    const decimalScale = (dbRaw & 0x8000) ? -(dbRaw & 0x7fff) : dbRaw;
    const bitsPerValue = body[offset + 8];
    const typeOfOriginalFieldValues = body[offset + 9];
    return { referenceValue, binaryScale, decimalScale, bitsPerValue, typeOfOriginalFieldValues };
}
/**
 * Apply the standard GRIB2 value transform:
 *
 *   Y = (R + X · 2^E) · 10^-D
 *
 * where X is an unsigned integer recovered from the packed bitstream.
 */
export function simpleDequantize(out, ints, header) {
    const { referenceValue, binaryScale, decimalScale } = header;
    const twoE = Math.pow(2, binaryScale);
    const tenD = Math.pow(10, -decimalScale);
    for (let i = 0; i < out.length; i++) {
        out[i] = (referenceValue + (ints[i] ?? 0) * twoE) * tenD;
    }
}
/**
 * Expand a Section 6 bitmap onto the native-grid value buffer: every grid
 * point whose bitmap bit is 0 is replaced with `missingValue` (NaN by default),
 * and the packed integer stream is only consumed for bits that are 1.
 *
 * In GRIB2 the bitmap is MSB-first.
 */
export function applyBitmap(dense, bitmap, unpackedCount, missing = NaN) {
    if (!bitmap)
        return dense;
    const total = dense.length;
    // `dense` currently has `unpackedCount` valid leading values; we need to
    // spread them into their bitmap positions and fill gaps with `missing`.
    const out = new Float32Array(total);
    let src = 0;
    for (let i = 0; i < total; i++) {
        const byte = bitmap[i >>> 3] ?? 0;
        const bit = (byte >> (7 - (i & 7))) & 1;
        if (bit) {
            out[i] = dense[src++] ?? missing;
        }
        else {
            out[i] = missing;
        }
    }
    if (src !== unpackedCount) {
        // Not fatal — some encoders mis-state the count — but worth surfacing.
        // eslint-disable-next-line no-console
        console.warn(`applyBitmap: consumed ${src} of ${unpackedCount} unpacked values`);
    }
    return out;
}
