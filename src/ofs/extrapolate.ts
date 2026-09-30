/**
 * Nearest-neighbour extrapolation of a gridded field into its NaN cells.
 *
 * OFS regular-grid output is NaN wherever the model's (~275 m) land mask
 * says land. When a finer shoreline mask does the clipping, water pixels
 * between the model's coast and the real coast would otherwise fall in NaN
 * cells and render as holes. Each pass fills every NaN cell that has at
 * least one finite 8-neighbour with the mean of those neighbours, growing
 * the field one cell per pass. Cells that never gain a finite neighbour
 * stay NaN, so open-ocean gaps and out-of-domain areas are untouched.
 */
export function fillMissingNearest(values: Float32Array, nx: number, ny: number, passes: number): Float32Array {
  let src = values;
  for (let p = 0; p < passes; p++) {
    const dst = new Float32Array(src);
    let changed = false;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const idx = j * nx + i;
        if (!Number.isNaN(src[idx]!)) continue;
        let sum = 0, n = 0;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = j + dj;
          if (jj < 0 || jj >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            if (ii < 0 || ii >= nx || (di === 0 && dj === 0)) continue;
            const v = src[jj * nx + ii]!;
            if (!Number.isNaN(v)) { sum += v; n++; }
          }
        }
        if (n > 0) { dst[idx] = sum / n; changed = true; }
      }
    }
    src = dst;
    if (!changed) break;
  }
  return src;
}
