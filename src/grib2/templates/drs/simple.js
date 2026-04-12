import { BitReader } from '../../reader.js';
import { applyBitmap, parseSimplePackingHeader, simpleDequantize } from './common.js';
/**
 * Data Representation Template 5.0 — Grid point data, simple packing.
 *
 * The packed byte stream in §7 is a big-endian bit-packed array of
 * `numberOfValues` unsigned integers, each `bitsPerValue` bits wide.
 *
 * Special case: `bitsPerValue === 0` means every value equals `R` exactly.
 */
export function unpackSimple(s5, s6, s7, totalPoints) {
    const header = parseSimplePackingHeader(s5.body);
    const count = s5.numberOfValues;
    let dense;
    if (header.bitsPerValue === 0) {
        const value = header.referenceValue * Math.pow(10, -header.decimalScale);
        dense = new Float32Array(count).fill(value);
    }
    else {
        const ints = new Uint32Array(count);
        const br = new BitReader(s7.data);
        for (let i = 0; i < count; i++)
            ints[i] = br.readBits(header.bitsPerValue);
        dense = new Float32Array(count);
        simpleDequantize(dense, ints, header);
    }
    if (s6.bitmapIndicator === 0 && s6.bitmap) {
        return applyBitmap(dense, s6.bitmap, count);
    }
    // No bitmap — count must equal total points on the grid.
    if (dense.length !== totalPoints) {
        const full = new Float32Array(totalPoints);
        full.set(dense.subarray(0, Math.min(dense.length, totalPoints)));
        return full;
    }
    return dense;
}
