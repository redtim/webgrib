/**
 * Data Representation Template 5.40 — grid point data, JPEG 2000 compression.
 *
 * The packed values are embedded as a single JPEG 2000 codestream (either a
 * raw J2K codestream or wrapped in a JP2 box container — most GRIB2 encoders
 * use a bare codestream). Per spec, samples are unsigned integers with
 * `bitsPerValue` bit depth; we treat the decoded sample grid as a flat
 * row-major array and feed it through the standard R/E/D transform.
 *
 * No ECMAScript engine ships a JPEG 2000 decoder. Callers must install one
 * via {@link setJpeg2000Decoder}. Two good choices:
 *
 *   1. `jpx.js` from PDF.js (pure JS, ~100 KB). Extract `core/jpx.js` and
 *      use `new JpxImage().parse(bytes)` → `image.tiles[0].items`.
 *   2. `openjpeg-wasm` / `@openjpegjs/openjpeg-wasm` (native speed).
 *
 * For the demo we lazy-load jpx.js from `/vendor/jpx.js` at runtime — see
 * `src/worker/jpegBootstrap.ts`. On Node, we use the same vendored file via
 * dynamic import.
 */
import { applyBitmap, parseSimplePackingHeader } from './common.js';
let decoder = null;
export function setJpeg2000Decoder(d) {
    decoder = d;
}
export function getJpeg2000Decoder() {
    return decoder;
}
export async function unpackJpeg2000(s5, s6, s7, totalPoints) {
    if (!decoder) {
        throw new Error('No JPEG2000 decoder registered. Call setJpeg2000Decoder() before decoding template 5.40 messages (e.g., the vendored jpx.js from PDF.js).');
    }
    const header = parseSimplePackingHeader(s5.body);
    const count = s5.numberOfValues;
    // Edge case: spec allows bitsPerValue=0 meaning "all values = R" with no
    // embedded codestream at all.
    if (header.bitsPerValue === 0) {
        const v = header.referenceValue * Math.pow(10, -header.decimalScale);
        const dense = new Float32Array(count).fill(v);
        if (s6.bitmapIndicator === 0 && s6.bitmap)
            return applyBitmap(dense, s6.bitmap, count);
        return padOrTruncate(dense, totalPoints);
    }
    const decoded = await Promise.resolve(decoder(s7.data));
    const samples = decoded.samples;
    const twoE = Math.pow(2, header.binaryScale);
    const tenD = Math.pow(10, -header.decimalScale);
    const dense = new Float32Array(count);
    const n = Math.min(count, samples.length);
    for (let i = 0; i < n; i++) {
        dense[i] = (header.referenceValue + samples[i] * twoE) * tenD;
    }
    if (s6.bitmapIndicator === 0 && s6.bitmap) {
        return applyBitmap(dense, s6.bitmap, count);
    }
    return padOrTruncate(dense, totalPoints);
}
function padOrTruncate(dense, totalPoints) {
    if (dense.length === totalPoints)
        return dense;
    const full = new Float32Array(totalPoints);
    full.set(dense.subarray(0, Math.min(dense.length, totalPoints)));
    return full;
}
