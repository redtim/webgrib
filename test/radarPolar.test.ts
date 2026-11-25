import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { Radial, Sweep, Volume } from '../src/radar/level2.js';
import { buildPolarGrid, coverageQuad, lowestSweepWith } from '../src/radar/polar.js';

const radial = (azimuth: number, codes: number[], name = 'REF', scale = 2, offset = 66): Radial => ({
  azimuth,
  elevation: 0.5,
  moments: { [name]: { firstGate: 2125, gateSpacing: 250, scale, offset, codes: Uint8Array.from(codes) } },
});

const sweep = (radials: Radial[], azimuthSpacing = 1, elevationNumber = 1): Sweep => ({
  elevationNumber, elevation: 0.5, azimuthSpacing, radials,
});

const row = (data: Uint8Array | Uint16Array, gates: number, bin: number) => Array.from(data.subarray(bin * gates, (bin + 1) * gates));

test('puts each radial in the azimuth row that covers it', () => {
  const grid = buildPolarGrid(sweep([radial(0.5, [1, 2]), radial(90.5, [3, 4])]), 'REF')!;
  assert.equal(grid.azimuthBins, 360);
  assert.equal(grid.gateCount, 2);
  assert.equal(grid.firstGate, 2125);
  assert.equal(grid.gateSpacing, 250);
  assert.deepEqual(row(grid.data, 2, 0), [1, 2]);
  assert.deepEqual(row(grid.data, 2, 90), [3, 4]);
});

test('closes the seam that azimuth jitter would otherwise leave', () => {
  // 10.95 and 12.15 both miss row 11 (11°–12°); the nearer one fills it.
  const grid = buildPolarGrid(sweep([radial(10.95, [7]), radial(12.15, [9])]), 'REF')!;
  assert.deepEqual([row(grid.data, 1, 10), row(grid.data, 1, 11), row(grid.data, 1, 12)], [[7], [7], [9]]);
});

test('wraps across north', () => {
  const grid = buildPolarGrid(sweep([radial(359.98, [5])]), 'REF')!;
  assert.deepEqual(row(grid.data, 1, 0), [5]);
  assert.deepEqual(row(grid.data, 1, 359), [5]);
});

test('leaves a missing sector empty', () => {
  const grid = buildPolarGrid(sweep([radial(10.5, [7])]), 'REF')!;
  assert.equal(grid.data[13], 0);
  assert.equal(grid.data[200], 0);
});

test('uses half-degree rows for super-resolution sweeps and pads short radials', () => {
  const grid = buildPolarGrid(sweep([radial(0.25, [1]), radial(0.75, [2, 3])], 0.5), 'REF')!;
  assert.equal(grid.azimuthBins, 720);
  assert.equal(grid.gateCount, 2);
  assert.equal(grid.data[0], 1);
  assert.equal(grid.data[1], 0);
  assert.deepEqual(row(grid.data, 2, 1), [2, 3]);
});

test('stores one byte per gate with the coding needed to read it', () => {
  const grid = buildPolarGrid(sweep([radial(0.5, [146])]), 'REF')!;
  assert.ok(grid.data instanceof Uint8Array);
  assert.equal(grid.data.length, 360);
  assert.deepEqual([grid.scale, grid.offset], [2, 66]);
});

test('re-codes a radial whose scale differs, preserving its values', () => {
  // The second radial's 73 means 40 dBZ, which is 146 in the first's coding.
  const grid = buildPolarGrid(sweep([
    radial(0.5, [146, 0, 1, 100]),
    radial(90.5, [73, 0, 1, 255], 'REF', 1, 33),
  ]), 'REF')!;
  assert.deepEqual(row(grid.data, 4, 90), [146, 0, 1, 255]); // the last clamps to the largest code
});

test('returns nothing for a moment the sweep does not carry', () => {
  assert.equal(buildPolarGrid(sweep([radial(0.5, [1])]), 'VEL'), undefined);
});

test('picks the lowest sweep that carries a moment', () => {
  const volume = {
    sweeps: [
      sweep([radial(0, [1])], 1, 1),
      sweep([radial(0, [1], 'VEL')], 1, 2),
      sweep([radial(0, [1], 'VEL')], 1, 4),
    ],
  } as Volume;
  assert.equal(lowestSweepWith(volume, 'REF')!.elevationNumber, 1);
  assert.equal(lowestSweepWith(volume, 'VEL')!.elevationNumber, 2);
  assert.equal(lowestSweepWith(volume, 'ZDR'), undefined);
});

test('bounds the coverage circle in unit mercator coordinates', () => {
  const [west, north, east, south] = coverageQuad(0, 0, 111_195); // one degree
  assert.ok(Math.abs(west - (0.5 - 1 / 360)) < 1e-5);
  assert.ok(Math.abs(east - (0.5 + 1 / 360)) < 1e-5);
  assert.ok(Math.abs(north - (0.5 - 1 / 360)) < 1e-5);
  assert.ok(Math.abs(south - (0.5 + 1 / 360)) < 1e-5);
});

test('widens the coverage box away from the equator', () => {
  const [west, , east] = coverageQuad(60, -120, 111_195);
  // A degree of distance spans over two degrees of longitude at 60°N.
  assert.ok((east - west) * 360 > 4);
});
