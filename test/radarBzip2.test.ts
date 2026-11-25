import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { bunzip2 } from '../src/radar/bzip2.js';

/** The system bzip2 is the oracle: whatever it compresses, we must restore. */
function compress(data: Uint8Array, level = 9): Uint8Array {
  return new Uint8Array(execFileSync('bzip2', [`-${level}`, '-c'], { input: data, maxBuffer: 1 << 26 }));
}

/** Deterministic pseudo-random bytes (xorshift32). */
function noise(length: number, alphabet = 256, seed = 12345): Uint8Array {
  const out = new Uint8Array(length);
  let x = seed;
  for (let i = 0; i < length; i++) {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    out[i] = (x >>> 0) % alphabet;
  }
  return out;
}

function roundTrip(data: Uint8Array, level = 9): void {
  const got = bunzip2(compress(data, level));
  assert.equal(got.length, data.length);
  assert.ok(Buffer.from(got).equals(Buffer.from(data)), 'decompressed bytes differ');
}

test('bunzip2 restores a short string', () => {
  roundTrip(new TextEncoder().encode('hello, radar hello, radar'));
});

test('bunzip2 restores an empty stream', () => {
  roundTrip(new Uint8Array(0));
});

test('bunzip2 restores long runs of one byte, around the run-length boundaries', () => {
  for (const n of [1, 3, 4, 5, 254, 255, 256, 259, 260, 100_000]) {
    roundTrip(new Uint8Array(n).fill(7));
  }
});

test('bunzip2 restores incompressible data', () => {
  roundTrip(noise(50_000));
});

test('bunzip2 restores data spanning several blocks', () => {
  roundTrip(noise(350_000, 6), 1);
});

test('bunzip2 rejects data that is not bzip2', () => {
  assert.throws(() => bunzip2(new TextEncoder().encode('not compressed')), /bzip2/i);
});

test('bunzip2 rejects a truncated stream', () => {
  const packed = compress(noise(20_000));
  assert.throws(() => bunzip2(packed.subarray(0, packed.length >> 1)), /bzip2/i);
});

test('bunzip2 rejects a corrupted block via its checksum', () => {
  const packed = compress(new TextEncoder().encode('the quick brown fox'.repeat(50)));
  packed[10]! ^= 0x01; // first byte of the stored block CRC
  assert.throws(() => bunzip2(packed), /bzip2.*CRC/i);
});
