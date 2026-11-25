import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildLut, PRODUCTS } from '../src/radar/colors.js';

/** RGBA the shader would pick for a value. */
function colorAt(product: 'REF' | 'VEL', value: number): number[] {
  const { min, max } = PRODUCTS[product];
  const lut = buildLut(PRODUCTS[product]);
  const i = Math.min(255, Math.max(0, Math.floor(((value - min) / (max - min)) * 256)));
  return Array.from(lut.subarray(i * 4, i * 4 + 4));
}

test('hides reflectivity below the display threshold', () => {
  assert.equal(colorAt('REF', -20)[3], 0);
});

test('colours reflectivity in discrete NWS bands', () => {
  assert.deepEqual(colorAt('REF', 21), [2, 253, 2, 255]);
  assert.deepEqual(colorAt('REF', 24), [2, 253, 2, 255]);
  assert.deepEqual(colorAt('REF', 51), [253, 0, 0, 255]);
});

test('colours inbound velocity green and outbound red', () => {
  const [ir, ig] = colorAt('VEL', -20);
  const [or, og] = colorAt('VEL', 20);
  assert.ok(ig! > ir!, 'inbound should be green');
  assert.ok(or! > og!, 'outbound should be red');
});
