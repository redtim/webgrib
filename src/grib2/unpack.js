/**
 * DRS dispatcher: given a parsed GRIB2 message, decode its §7 data into a
 * Float32Array on the native grid, in scan order. NaN marks missing values.
 */
import { unpackSimple } from './templates/drs/simple.js';
import { unpackComplex, unpackComplexSpatial } from './templates/drs/complex.js';
import { unpackPng } from './templates/drs/png.js';
import { unpackJpeg2000 } from './templates/drs/jpeg2000.js';
export async function decodeMessage(msg) {
    const grid = msg.section3.grid;
    const nx = 'nx' in grid ? grid.nx : 0;
    const ny = 'ny' in grid ? grid.ny : 0;
    const totalPoints = grid.numberOfPoints || nx * ny;
    const { section5: s5, section6: s6, section7: s7 } = msg;
    let values;
    switch (s5.template) {
        case 0:
            values = unpackSimple(s5, s6, s7, totalPoints);
            break;
        case 2:
            values = unpackComplex(s5, s6, s7, totalPoints);
            break;
        case 3:
            values = unpackComplexSpatial(s5, s6, s7, totalPoints);
            break;
        case 40:
        case 40000:
            values = await unpackJpeg2000(s5, s6, s7, totalPoints);
            break;
        case 41:
        case 40001:
            values = await unpackPng(s5, s6, s7, totalPoints);
            break;
        default:
            throw new Error(`Unsupported Data Representation Template 5.${s5.template}`);
    }
    // Compute min/max (skip NaN).
    let min = Infinity, max = -Infinity;
    for (let i = 0; i < values.length; i++) {
        const v = values[i];
        if (v < min)
            min = v;
        if (v > max)
            max = v;
    }
    if (!Number.isFinite(min))
        min = 0;
    if (!Number.isFinite(max))
        max = 0;
    return { values, nx, ny, missingValue: NaN, min, max };
}
