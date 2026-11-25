import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { gzipSync } from 'node:zlib';

import { gateValue, OLDER_FORMAT_MESSAGE, parseVolume, RANGE_FOLDED, readVolume } from '../src/radar/level2.js';

// ── Synthetic Level II volume builder (layout per NOAA ICD 2620002 / 2620010) ──

function bytes(length: number, fill: (view: DataView) => void = () => {}): Uint8Array {
  const out = new Uint8Array(length);
  fill(new DataView(out.buffer));
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  return new Uint8Array(Buffer.concat(parts));
}

const ascii = (s: string) => new TextEncoder().encode(s);

function momentBlock(name: string, raw: number[], opts: { wordSize?: 8 | 16; scale?: number; offset?: number } = {}): Uint8Array {
  const { wordSize = 8, scale = 2, offset = 66 } = opts;
  return bytes(28 + raw.length * (wordSize / 8), (v) => {
    new Uint8Array(v.buffer).set(ascii(`D${name.padEnd(3)}`));
    v.setUint16(8, raw.length);
    v.setUint16(10, 2125);
    v.setUint16(12, 250);
    v.setUint8(19, wordSize);
    v.setFloat32(20, scale);
    v.setFloat32(24, offset);
    raw.forEach((value, i) => {
      if (wordSize === 8) v.setUint8(28 + i, value);
      else v.setUint16(28 + 2 * i, value);
    });
  });
}

function volumeBlock(): Uint8Array {
  return bytes(44, (v) => {
    new Uint8Array(v.buffer).set(ascii('RVOL'));
    v.setFloat32(8, 37.155);
    v.setFloat32(12, -121.898);
    v.setInt16(16, 1057);
    v.setUint16(18, 20);
    v.setUint16(40, 215);
  });
}

interface RadialSpec {
  azimuth: number;
  elevationNumber: number;
  elevation: number;
  spacingCode?: 1 | 2;
  blocks: Uint8Array[];
}

/** Wrap a message body in the 12-byte CTM pad and 16-byte message header. */
function message(type: number, body: Uint8Array): Uint8Array {
  const padded = body.length + (body.length % 2);
  const length = type === 31 ? 12 + 16 + padded : 2432;
  return bytes(length, (v) => {
    v.setUint16(12, type === 31 ? (16 + padded) / 2 : 1208);
    v.setUint8(15, type);
    new Uint8Array(v.buffer).set(body, 28);
  });
}

function radial(spec: RadialSpec): Uint8Array {
  const headerLength = 32 + 4 * spec.blocks.length;
  const header = bytes(headerLength, (v) => {
    new Uint8Array(v.buffer).set(ascii('KMUX'));
    v.setFloat32(12, spec.azimuth);
    v.setUint8(20, spec.spacingCode ?? 1);
    v.setUint8(22, spec.elevationNumber);
    v.setFloat32(24, spec.elevation);
    v.setUint16(30, spec.blocks.length);
    let at = headerLength;
    spec.blocks.forEach((block, i) => {
      v.setUint32(32 + 4 * i, at);
      at += block.length;
    });
  });
  return message(31, concat(header, ...spec.blocks));
}

function ldmRecord(payload: Uint8Array, last = false): Uint8Array {
  const packed = new Uint8Array(execFileSync('bzip2', ['-c'], { input: payload }));
  const control = bytes(4, (v) => v.setInt32(0, last ? -packed.length : packed.length));
  return concat(control, packed);
}

function volumeHeader(tape = 'AR2V0006.299'): Uint8Array {
  return bytes(24, (v) => {
    new Uint8Array(v.buffer).set(ascii(tape));
    v.setUint32(12, 20783); // day 1 is 1970-01-01, so this is 2026-11-25
    v.setUint32(16, 60_725_000); // 16:52:05 UTC
    new Uint8Array(v.buffer).set(ascii('KMUX'), 20);
  });
}

function archive(...records: Uint8Array[]): Uint8Array {
  return concat(volumeHeader(), ...records);
}

/** The 2008–2016 layout: messages straight after the header, all gzipped. */
const gzipped = (...messages: Uint8Array[]) =>
  new Uint8Array(gzipSync(concat(volumeHeader('AR2V0003.984'), ...messages)));

const metadata = () => ldmRecord(concat(message(15, bytes(10)), message(0, bytes(0)), message(5, bytes(10))));

const lowSweepRadial = (azimuth: number) =>
  radial({
    azimuth,
    elevationNumber: 1,
    elevation: 0.48,
    blocks: [volumeBlock(), momentBlock('REF', [0, 1, 66, 146])],
  });

// ── Tests ──

test('reads site, scan time, location and VCP', () => {
  const volume = parseVolume(archive(metadata(), ldmRecord(lowSweepRadial(10.25), true)));
  assert.equal(volume.site, 'KMUX');
  assert.equal(volume.time.toISOString(), '2026-11-25T16:52:05.000Z');
  assert.ok(Math.abs(volume.latitude - 37.155) < 1e-4);
  assert.ok(Math.abs(volume.longitude + 121.898) < 1e-4);
  assert.equal(volume.height, 1077); // site elevation + feedhorn height
  assert.equal(volume.vcp, 215);
});

test('groups radials into sweeps by elevation number, across records', () => {
  const upper = radial({ azimuth: 90, elevationNumber: 2, elevation: 1.3, spacingCode: 2, blocks: [momentBlock('VEL', [2])] });
  const volume = parseVolume(archive(
    metadata(),
    ldmRecord(concat(lowSweepRadial(10.25), lowSweepRadial(10.75))),
    ldmRecord(concat(lowSweepRadial(11.25), upper), true),
  ));
  assert.deepEqual(volume.sweeps.map((s) => s.elevationNumber), [1, 2]);
  const [low, high] = volume.sweeps;
  assert.deepEqual(low!.radials.map((r) => r.azimuth), [10.25, 10.75, 11.25]);
  assert.equal(low!.azimuthSpacing, 0.5);
  assert.ok(Math.abs(low!.elevation - 0.48) < 1e-4);
  assert.equal(high!.azimuthSpacing, 1);
  assert.deepEqual(Object.keys(high!.radials[0]!.moments), ['VEL']);
});

test('reports the median elevation, ignoring antenna settling on the first radial', () => {
  const at = (elevation: number) =>
    radial({ azimuth: 0, elevationNumber: 1, elevation, blocks: [volumeBlock()] });
  const volume = parseVolume(archive(ldmRecord(concat(at(0.04), at(0.5), at(0.52)), true)));
  assert.equal(volume.sweeps[0]!.elevation, 0.5);
});

test('keeps 8-bit gates as their codes, converting them on demand', () => {
  const volume = parseVolume(archive(ldmRecord(lowSweepRadial(0.25), true)));
  const ref = volume.sweeps[0]!.radials[0]!.moments.REF!;
  assert.equal(ref.firstGate, 2125);
  assert.equal(ref.gateSpacing, 250);
  assert.deepEqual(ref.codes, Uint8Array.of(0, 1, 66, 146));
  const [none, folded, zero, forty] = Array.from(ref.codes, (c) => gateValue(c, ref.scale, ref.offset));
  assert.ok(Number.isNaN(none!));
  assert.equal(folded, RANGE_FOLDED);
  assert.equal(zero, 0);
  assert.equal(forty, 40);
});

test('keeps 16-bit gates as two-byte codes', () => {
  const wide = radial({
    azimuth: 0, elevationNumber: 1, elevation: 0.5,
    blocks: [volumeBlock(), momentBlock('PHI', [0, 1000], { wordSize: 16, scale: 4, offset: 2 })],
  });
  const phi = parseVolume(archive(ldmRecord(wide, true))).sweeps[0]!.radials[0]!.moments.PHI!;
  assert.deepEqual(phi.codes, Uint16Array.of(0, 1000));
  assert.equal(gateValue(phi.codes[1]!, phi.scale, phi.offset), 249.5);
});

test('stops decompressing once past the requested elevation', () => {
  const upper = radial({ azimuth: 0, elevationNumber: 2, elevation: 1.3, blocks: [volumeBlock()] });
  const garbage = concat(bytes(4, (v) => v.setInt32(0, 6)), ascii('BROKEN'));
  const file = archive(metadata(), ldmRecord(lowSweepRadial(0.25)), ldmRecord(upper), garbage);
  const volume = parseVolume(file, { maxElevationNumber: 1 });
  assert.deepEqual(volume.sweeps.map((s) => s.elevationNumber), [1]);
  assert.throws(() => parseVolume(file), /bzip2/);
});

/** A stream delivering `data` in small pieces, noting whether it was cancelled. */
function trickle(data: Uint8Array, size = 7, delayMs?: number) {
  const state = { sent: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      // Real downloads arrive over time; without a delay a decompressor can
      // drain the whole source before the reader sees any output.
      if (delayMs !== undefined) await pause(delayMs);
      if (state.sent >= data.length) return controller.close();
      controller.enqueue(data.slice(state.sent, state.sent + size));
      state.sent += size;
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { stream, state };
}

test('reads a volume that arrives in pieces', async () => {
  const file = archive(metadata(), ldmRecord(lowSweepRadial(10.25)), ldmRecord(lowSweepRadial(10.75), true));
  const volume = await readVolume(trickle(file).stream);
  assert.deepEqual(volume, parseVolume(file));
});

test('cancels the download once it has the requested elevations', async () => {
  const upper = radial({ azimuth: 0, elevationNumber: 2, elevation: 1.3, blocks: [volumeBlock()] });
  const needed = archive(metadata(), ldmRecord(lowSweepRadial(0.25)), ldmRecord(upper));
  const file = concat(needed, new Uint8Array(5000));
  const { stream, state } = trickle(file);
  const volume = await readVolume(stream, { maxElevationNumber: 1 });
  assert.deepEqual(volume.sweeps.map((s) => s.elevationNumber), [1]);
  assert.ok(state.cancelled, 'stream should be cancelled');
  assert.ok(state.sent < needed.length + 100, `read ${state.sent} of ${file.length} bytes`);
});

test('reports a download that ends mid-record as truncated', async () => {
  const file = archive(ldmRecord(lowSweepRadial(0.25), true));
  await assert.rejects(readVolume(trickle(file.subarray(0, file.length - 5)).stream), /truncated/);
});

test('reads a gzip file of bare messages, as archived from 2008 to 2016', async () => {
  const messages = [message(15, bytes(10)), message(0, bytes(0)), lowSweepRadial(10.25), lowSweepRadial(10.75)];
  const volume = await readVolume(trickle(gzipped(...messages)).stream);
  const same = parseVolume(archive(ldmRecord(concat(...messages), true)));
  assert.deepEqual(volume, same);
});

test('cancels a gzip download once it has the requested elevations', async () => {
  const upper = radial({ azimuth: 0, elevationNumber: 2, elevation: 1.3, blocks: [volumeBlock()] });
  const file = gzipped(lowSweepRadial(0.25), upper, new Uint8Array(randomBytes(400_000)));
  const { stream, state } = trickle(file, 512, 1);
  const volume = await readVolume(stream, { maxElevationNumber: 1 });
  await pause(20);
  assert.deepEqual(volume.sweeps.map((s) => s.elevationNumber), [1]);
  assert.ok(state.cancelled, 'source stream should be cancelled');
  assert.ok(state.sent < file.length / 2, `read ${state.sent} of ${file.length} bytes`);
});

test('names the older message format instead of failing obscurely', async () => {
  const legacy = gzipped(message(15, bytes(10)), message(1, bytes(10)));
  await assert.rejects(readVolume(trickle(legacy).stream), { message: OLDER_FORMAT_MESSAGE });
  assert.throws(() => parseVolume(concat(volumeHeader('ARCHIVE2.388'), bytes(100))), { message: OLDER_FORMAT_MESSAGE });
});

test('reports a gzip file that stops inside a radial', async () => {
  const whole = concat(volumeHeader(), lowSweepRadial(0.25));
  const cutInside = new Uint8Array(gzipSync(whole.subarray(0, whole.length - 5)));
  await assert.rejects(readVolume(trickle(cutInside).stream), /truncated/);
});

test('reports a gzip download that ends early', async () => {
  const file = gzipped(lowSweepRadial(0.25));
  await assert.rejects(readVolume(trickle(file.subarray(0, file.length - 12)).stream), /truncated|damaged/);
});

test('rejects a file that is not a Level II archive', () => {
  assert.throws(() => parseVolume(ascii('<?xml version="1.0"?><Error/>')), /not a NEXRAD Level II/);
});

test('rejects a truncated record', () => {
  const file = archive(ldmRecord(lowSweepRadial(0.25), true));
  assert.throws(() => parseVolume(file.subarray(0, file.length - 5)), /truncated/);
});

test('rejects a volume with no radials', () => {
  assert.throws(() => parseVolume(archive(metadata())), /no radials/);
});
