/**
 * Data Representation Templates 5.2 (complex packing) and 5.3 (complex
 * packing with spatial differencing).
 *
 * Complex packing splits the stream into groups. Each group carries its own
 * reference value, width (bits per element), and length. The §5 header lays
 * out three arrays packed back-to-back in §7:
 *
 *   1) group references — NG values, `bitsPerGroupReference` bits each
 *   2) group widths     — NG values, `bitsPerGroupWidth` bits each
 *   3) group lengths    — NG values, `bitsPerGroupLength` bits each (if
 *                          the length is not constant)
 *   4) packed data      — for each group, `groupLen[g]` integers of
 *                          `groupWidth[g]` bits each
 *
 * Each unpacked integer X_i is then transformed via:
 *   X_i' = groupRef[g] + X_i
 *   Y_i  = (R + X_i' · 2^E) · 10^-D
 *
 * Template 5.3 prepends a spatial-difference preamble to the group-reference
 * array: a few "override" values that were removed before differencing, plus
 * the minimum of the differences (subtracted out to make everything
 * non-negative). After undoing the group-level unpacking, you run a cumulative
 * sum (1st order) or a second-order reconstruction (2nd order) to recover
 * the original values.
 *
 * The §5 body layout (starting after template number was read) is:
 *
 *   0..3   R (IEEE float32)
 *   4..5   E
 *   6..7   D
 *   8      nbits
 *   9      type of original field values
 *  10      group splitting method (0 = row, 1 = general)
 *  11      missing value management (0 = none, 1 = primary, 2 = primary+secondary)
 *  12..15  primary missing value substitute
 *  16..19  secondary missing value substitute
 *  20..23  NG — number of groups
 *  24      reference for group widths
 *  25      bits per group widths
 *  26..29  reference for group lengths
 *  30      length increment for the group lengths
 *  31..34  true length of last group
 *  35      bits for scaled group lengths
 *
 * Template 5.3 adds:
 *  36      order of spatial differencing (1 or 2)
 *  37      number of octets required for each of the extra descriptors
 */

import { BitReader } from '../../reader.js';
import type { Section5, Section6, Section7 } from '../../types.js';
import { applyBitmap, parseSimplePackingHeader } from './common.js';

interface ComplexHeader {
  R: number;
  E: number;
  D: number;
  nbits: number;
  missingManagement: number;
  primaryMissing: number;
  secondaryMissing: number;
  numberOfGroups: number;
  refForGroupWidths: number;
  bitsPerGroupWidths: number;
  refForGroupLengths: number;
  groupLengthIncrement: number;
  trueLengthOfLastGroup: number;
  bitsForScaledGroupLengths: number;
  // 5.3 only
  orderOfSpatialDifference: number;
  octetsForExtra: number;
}

function parseComplexHeader(body: Uint8Array, withSpatialDiff: boolean): ComplexHeader {
  const simple = parseSimplePackingHeader(body);
  const dv = new DataView(body.buffer, body.byteOffset, body.byteLength);
  const h: ComplexHeader = {
    R: simple.referenceValue,
    E: simple.binaryScale,
    D: simple.decimalScale,
    nbits: simple.bitsPerValue,
    missingManagement: body[11]!,
    primaryMissing: dv.getUint32(12, false),
    secondaryMissing: dv.getUint32(16, false),
    numberOfGroups: dv.getUint32(20, false),
    refForGroupWidths: body[24]!,
    bitsPerGroupWidths: body[25]!,
    refForGroupLengths: dv.getUint32(26, false),
    groupLengthIncrement: body[30]!,
    trueLengthOfLastGroup: dv.getUint32(31, false),
    bitsForScaledGroupLengths: body[35]!,
    orderOfSpatialDifference: withSpatialDiff ? body[36]! : 0,
    octetsForExtra: withSpatialDiff ? body[37]! : 0,
  };
  return h;
}

/**
 * Dequantize by mapping each unpacked sub-integer through its group reference,
 * then the global R/E/D transform. `missingManagement` handles sentinel codes:
 * when enabled, a value of `(1 << groupWidth) - 1` (and, for mgmt==2, that
 * minus 1) represents missing and is written as NaN.
 */
function finalizeValues(
  out: Float32Array,
  groupRef: Int32Array,
  groupLen: Int32Array,
  groupWidth: Int32Array,
  packed: Uint8Array,
  packedBitOffset: number,
  h: ComplexHeader,
): void {
  const twoE = Math.pow(2, h.E);
  const tenD = Math.pow(10, -h.D);
  const br = new BitReader(packed, packedBitOffset);

  let outPos = 0;
  for (let g = 0; g < h.numberOfGroups; g++) {
    const ref = groupRef[g]!;
    const len = groupLen[g]!;
    const width = groupWidth[g]!;

    if (width === 0) {
      // All values in this group equal the group reference.
      for (let i = 0; i < len; i++) out[outPos++] = ref;
      continue;
    }

    const maxValue = (1 << width) - 1;
    const primaryMissing = maxValue;
    const secondaryMissing = maxValue - 1;

    for (let i = 0; i < len; i++) {
      const x = br.readBits(width);
      if (h.missingManagement >= 1 && x === primaryMissing) {
        out[outPos++] = NaN;
      } else if (h.missingManagement === 2 && x === secondaryMissing) {
        out[outPos++] = NaN;
      } else {
        out[outPos++] = ref + x;
      }
    }
  }

  // Now apply R/E/D to everything that isn't NaN.
  for (let i = 0; i < out.length; i++) {
    const v = out[i]!;
    if (Number.isNaN(v)) continue;
    out[i] = (h.R + v * twoE) * tenD;
  }
}

/**
 * Decode complex packing (template 5.2). Returns `numberOfValues` values in
 * the native scan order of the grid, before bitmap expansion.
 */
export function unpackComplex(s5: Section5, s6: Section6, s7: Section7, totalPoints: number): Float32Array {
  return unpackComplexInternal(s5, s6, s7, totalPoints, false);
}

/**
 * Decode complex packing with spatial differencing (template 5.3). The
 * first-order variant is a cumulative sum; the second-order variant uses two
 * seed values.
 */
export function unpackComplexSpatial(s5: Section5, s6: Section6, s7: Section7, totalPoints: number): Float32Array {
  return unpackComplexInternal(s5, s6, s7, totalPoints, true);
}

function unpackComplexInternal(
  s5: Section5,
  s6: Section6,
  s7: Section7,
  totalPoints: number,
  withSpatialDiff: boolean,
): Float32Array {
  const h = parseComplexHeader(s5.body, withSpatialDiff);
  const count = s5.numberOfValues;

  // ---- Spatial differencing preamble (5.3 only)
  // The preamble lives at the very start of §7 data and is encoded as
  // `octetsForExtra`-byte sign-magnitude integers:
  //   order 1: g0, gMin
  //   order 2: g0, g1, gMin
  let diffOrder = 0;
  let g0 = 0, g1 = 0, gMin = 0;
  let byteCursor = 0;
  if (withSpatialDiff) {
    diffOrder = h.orderOfSpatialDifference;
    const octets = h.octetsForExtra;
    const readSM = (): number => {
      let v = 0;
      // Multiplication-based read: JS bit-shifts are signed 32-bit and would
      // corrupt values with bit 31 set. This stays in doubles.
      for (let i = 0; i < octets; i++) v = v * 256 + s7.data[byteCursor + i]!;
      byteCursor += octets;
      const signMask = Math.pow(2, octets * 8 - 1);
      return v >= signMask ? -(v - signMask) : v;
    };
    g0 = readSM();
    if (diffOrder === 2) g1 = readSM();
    gMin = readSM();
  }

  // ---- Group references
  const groupRef = new Int32Array(h.numberOfGroups);
  {
    const br = new BitReader(s7.data, byteCursor * 8);
    for (let g = 0; g < h.numberOfGroups; g++) groupRef[g] = br.readBits(h.nbits);
    br.align();
    byteCursor = br.position >>> 3;
  }

  // ---- Group widths (bitsPerGroupWidths bits each, offset by refForGroupWidths)
  const groupWidth = new Int32Array(h.numberOfGroups);
  {
    const br = new BitReader(s7.data, byteCursor * 8);
    for (let g = 0; g < h.numberOfGroups; g++) {
      groupWidth[g] = h.refForGroupWidths + br.readBits(h.bitsPerGroupWidths);
    }
    br.align();
    byteCursor = br.position >>> 3;
  }

  // ---- Group lengths.
  // Read ALL ngroups scaled-length values from the stream (not ngroups - 1),
  // then overwrite the last with the `trueLengthOfLastGroup` field from the
  // §5 header. The scaled length for the last group is still present in the
  // packed bitstream and we MUST consume it — skipping the read would leave
  // the bit cursor 10-ish bits short, shifting every subsequent packed-data
  // read and corrupting the spatial-differencing reconstruction downstream.
  const groupLen = new Int32Array(h.numberOfGroups);
  {
    const br = new BitReader(s7.data, byteCursor * 8);
    for (let g = 0; g < h.numberOfGroups; g++) {
      const scaled = br.readBits(h.bitsForScaledGroupLengths);
      groupLen[g] = h.refForGroupLengths + scaled * h.groupLengthIncrement;
    }
    groupLen[h.numberOfGroups - 1] = h.trueLengthOfLastGroup;
    br.align();
    byteCursor = br.position >>> 3;
  }

  // ---- Packed data values
  const values = new Float32Array(count);
  // Temporarily use `values` as an integer buffer (pre-R/E/D). We'll run a
  // second pass if spatial differencing is active, but the group-ref offset
  // is already applied by finalizeValues — which we don't want for 5.3. So
  // for 5.3 we manually unpack and defer finalization until after the diff.
  if (withSpatialDiff) {
    // 2nd-order spatial differencing accumulates over ~2M integer samples;
    // Float32's 24-bit mantissa is not enough and drift compounds rapidly.
    // Do the reconstruction in Float64 and downcast at the end.
    const raw = new Float64Array(count);
    const br = new BitReader(s7.data, byteCursor * 8);
    let outPos = 0;
    for (let g = 0; g < h.numberOfGroups; g++) {
      const ref = groupRef[g]!;
      const len = groupLen[g]!;
      const width = groupWidth[g]!;
      if (width === 0) {
        for (let i = 0; i < len; i++) raw[outPos++] = ref;
      } else {
        const maxValue = (1 << width) - 1;
        const primaryMissing = maxValue;
        const secondaryMissing = maxValue - 1;
        for (let i = 0; i < len; i++) {
          const x = br.readBits(width);
          if (h.missingManagement >= 1 && x === primaryMissing) raw[outPos++] = NaN;
          else if (h.missingManagement === 2 && x === secondaryMissing) raw[outPos++] = NaN;
          else raw[outPos++] = ref + x;
        }
      }
    }

    // Reconstruct from spatial differences. The first `diffOrder` values are
    // seeded directly; the rest are accumulated deltas plus gMin.
    if (diffOrder === 1) {
      raw[0] = g0;
      for (let i = 1; i < count; i++) {
        if (Number.isNaN(raw[i]!)) continue;
        raw[i] = raw[i]! + gMin + raw[i - 1]!;
      }
    } else if (diffOrder === 2) {
      raw[0] = g0;
      raw[1] = g1;
      for (let i = 2; i < count; i++) {
        if (Number.isNaN(raw[i]!)) continue;
        raw[i] = raw[i]! + gMin + 2 * raw[i - 1]! - raw[i - 2]!;
      }
    }

    // Apply R/E/D.
    const twoE = Math.pow(2, h.E);
    const tenD = Math.pow(10, -h.D);
    for (let i = 0; i < count; i++) {
      const v = raw[i]!;
      values[i] = Number.isNaN(v) ? NaN : (h.R + v * twoE) * tenD;
    }
  } else {
    finalizeValues(values, groupRef, groupLen, groupWidth, s7.data, byteCursor * 8, h);
  }

  if (s6.bitmapIndicator === 0 && s6.bitmap) {
    return applyBitmap(values, s6.bitmap, count);
  }
  if (values.length !== totalPoints) {
    const full = new Float32Array(totalPoints);
    full.set(values.subarray(0, Math.min(values.length, totalPoints)));
    return full;
  }
  return values;
}
