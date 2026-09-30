import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fillMissingNearest } from '../src/ofs/extrapolate.js';

test('fills NaN cells from finite neighbours one ring per pass', () => {
  const N = NaN;
  const nx = 5, ny = 1;
  const v = new Float32Array([1, N, N, N, 5]);
  const one = fillMissingNearest(v, nx, ny, 1);
  assert.deepEqual(Array.from(one).map((x) => (Number.isNaN(x) ? 'nan' : x)), [1, 1, 'nan', 5, 5]);
  const two = fillMissingNearest(v, nx, ny, 2);
  assert.equal(two[2], 3); // mean of 1 and 5 once both sides have grown in
  assert.ok(Number.isNaN(v[1]!), 'input is not mutated');
});

test('leaves fully isolated NaN regions alone', () => {
  const v = new Float32Array([NaN, NaN, NaN, NaN]);
  const out = fillMissingNearest(v, 2, 2, 5);
  assert.ok(Array.from(out).every(Number.isNaN));
});
