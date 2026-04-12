/**
 * Lazy bootstrap for a JPEG 2000 decoder. The default implementation expects
 * `vendor/jpx.js` to export a PDF.js-compatible `JpxImage` class:
 *
 *   class JpxImage {
 *     parse(data: Uint8Array): void
 *     width: number
 *     height: number
 *     componentsCount: number
 *     tiles: Array<{ items: Int32Array | Uint32Array; width: number; height: number }>
 *   }
 *
 * Drop the extracted `src/core/jpx.js` from PDF.js into `vendor/jpx.js` (or
 * use the ESM build from an npm mirror) and it wires up automatically on
 * first call.
 *
 * If you prefer openjpeg-wasm or another decoder, just call
 * {@link setJpeg2000Decoder} yourself before decoding anything.
 */
import { getJpeg2000Decoder, setJpeg2000Decoder } from './jpeg2000.js';
let loadPromise = null;
export async function ensureJpxDecoder() {
    if (getJpeg2000Decoder())
        return;
    if (!loadPromise) {
        loadPromise = loadJpx().catch((err) => {
            loadPromise = null;
            throw err;
        });
    }
    await loadPromise;
}
async function loadJpx() {
    // Dynamic import path is kept as a runtime string so TS/Vite don't try to
    // resolve it at build time — `vendor/jpx.js` is an optional drop-in.
    const vendorPath = '/vendor/jpx.js';
    const mod = (await import(/* @vite-ignore */ vendorPath));
    if (!mod?.JpxImage) {
        throw new Error('vendor/jpx.js did not export JpxImage. Drop PDF.js core/jpx.js into vendor/ or register a decoder via setJpeg2000Decoder().');
    }
    const JpxImage = mod.JpxImage;
    setJpeg2000Decoder((bytes) => {
        const image = new JpxImage();
        image.parse(bytes);
        const tile = image.tiles[0];
        if (!tile)
            throw new Error('JPEG2000 decode produced no tiles');
        // GRIB2 5.40 uses a single component. If PDF.js gave us an interleaved
        // sample array for multi-component data, we'd need to deinterleave. In
        // practice componentsCount is always 1 here.
        return { width: image.width, height: image.height, samples: tile.items };
    });
}
