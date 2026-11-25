/**
 * Parser for NEXRAD Level II archive files. Layout, per NOAA ICDs 2620010
 * (archive) and 2620002 (messages):
 *
 *   24-byte volume header
 *   then either (2016 on)  repeated: 4-byte control word (signed record length)
 *                          + one bzip2 stream of messages
 *   or (2008–2016)         bare messages, the whole file being gzipped
 *   each message: a 12-byte pad and a 16-byte header
 *
 * Only message type 31 (digital radar data, one radial) carries gates; every
 * other type occupies a fixed 2432-byte frame and is skipped.
 */

import { bunzip2 } from './bzip2.js';

/** Gate value meaning "echo is range folded" (code 1). Below threshold is NaN. */
export const RANGE_FOLDED = -999;

/** Gate codes as stored in the file: one byte each, or two for some moments. */
export type Codes = Uint8Array | Uint16Array;

/** Physical value (dBZ, m/s, …) of a gate code. */
export function gateValue(code: number, scale: number, offset: number): number {
  if (code === 0) return NaN;
  if (code === 1) return RANGE_FOLDED;
  return scale === 0 ? code : (code - offset) / scale;
}

const VOLUME_HEADER_LENGTH = 24;
const CTM_LENGTH = 12;
const MESSAGE_HEADER_LENGTH = 16;
const FIXED_FRAME_LENGTH = 2432;
/** Message type of the radials used before 2008. */
const LEGACY_RADIAL = 1;

export const OLDER_FORMAT_MESSAGE = 'This scan uses an older data format that is not supported yet';

export interface Moment {
  /** Distance to the centre of the first gate, metres along the beam. */
  firstGate: number;
  gateSpacing: number;
  /** Coding of the gates; see {@link gateValue}. */
  scale: number;
  offset: number;
  codes: Codes;
}

export interface Radial {
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** Beam elevation, degrees. */
  elevation: number;
  /** Keyed by moment name: REF, VEL, SW, ZDR, PHI, RHO, CFP. */
  moments: Record<string, Moment>;
}

/** One rotation of the antenna. */
export interface Sweep {
  elevationNumber: number;
  /** Median elevation of the radials, degrees. */
  elevation: number;
  /** Nominal degrees between radials: 0.5 or 1. */
  azimuthSpacing: number;
  radials: Radial[];
}

export interface Volume {
  site: string;
  time: Date;
  latitude: number;
  longitude: number;
  /** Antenna height above sea level, metres. */
  height: number;
  /** Volume coverage pattern number. */
  vcp: number;
  sweeps: Sweep[];
}

export interface ParseOptions {
  /** Stop reading once a radial above this elevation number appears. */
  maxElevationNumber?: number;
}

function text(data: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...data.subarray(offset, offset + length));
}

function viewOf(data: Uint8Array): DataView {
  return new DataView(data.buffer, data.byteOffset, data.byteLength);
}

function parseMoment(block: DataView): Moment {
  const gateCount = block.getUint16(8);
  const wordSize = block.getUint8(19);
  if (wordSize !== 8 && wordSize !== 16) throw new Error(`Unsupported gate word size: ${wordSize}`);
  if (28 + (gateCount * wordSize) / 8 > block.byteLength) throw new Error('Level II moment data is truncated');
  // Copied, so the gates do not keep the whole decompressed record alive.
  let codes: Codes;
  if (wordSize === 8) {
    codes = new Uint8Array(block.buffer, block.byteOffset + 28, gateCount).slice();
  } else {
    codes = new Uint16Array(gateCount);
    for (let i = 0; i < gateCount; i++) codes[i] = block.getUint16(28 + 2 * i);
  }
  return {
    firstGate: block.getUint16(10),
    gateSpacing: block.getUint16(12),
    scale: block.getFloat32(20),
    offset: block.getFloat32(24),
    codes,
  };
}

/**
 * Parses a Level II file as it arrives. Records are independent, so reading can
 * stop as soon as the wanted elevations are complete.
 */
export class VolumeReader {
  private readonly maxElevation: number;
  private readonly sweeps = new Map<number, Sweep>();
  private volume: Volume | null = null;
  /** Bytes received but not yet consumed. */
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  /** Smallest `buffered` at which more progress is possible. */
  private needed = VOLUME_HEADER_LENGTH;
  private complete = false;
  /** How messages are packed, known from the bytes after the header. */
  private packing: 'records' | 'messages' | null = null;

  constructor(options: ParseOptions = {}) {
    this.maxElevation = options.maxElevationNumber ?? Infinity;
  }

  /** Feed the next bytes of the file. True once no more are needed. */
  push(chunk: Uint8Array): boolean {
    if (this.complete) return true;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    if (this.buffered < this.needed) return false;

    const data = join(this.chunks, this.buffered);
    let offset = 0;
    if (!this.volume) {
      this.volume = readHeader(data);
      offset = VOLUME_HEADER_LENGTH;
    }
    if (!this.packing && data.length - offset >= 7) {
      // A bzip2 record starts with its length, then the "BZh" signature.
      this.packing = text(data, offset + 4, 3) === 'BZh' ? 'records' : 'messages';
    }
    if (this.packing === 'records') offset = this.readRecords(data, offset, this.volume);
    else if (this.packing === 'messages') offset = this.readStream(data, offset, this.volume);
    else this.needed = 7;
    this.chunks = [data.subarray(offset)];
    this.buffered = data.length - offset;
    return this.complete;
  }

  /** The parsed volume, once all the needed bytes have been pushed. */
  finish(): Volume {
    const { volume } = this;
    if (!volume) throw new Error(NOT_LEVEL2);
    if (!this.complete && this.endsMidway()) throw new Error('Level II file is truncated');
    if (volume.sweeps.length === 0) throw new Error('Level II file contains no radials');
    if (Number.isNaN(volume.latitude)) throw new Error('Level II file has no radar location');
    for (const sweep of volume.sweeps) {
      const elevations = sweep.radials.map((r) => r.elevation).sort((a, b) => a - b);
      sweep.elevation = elevations[elevations.length >> 1]!;
    }
    return volume;
  }

  private endsMidway(): boolean {
    if (this.packing === 'records') return this.buffered >= 4;
    // Trailing padding is harmless; half a radial is not.
    const rest = join(this.chunks, this.buffered);
    return rest.length >= CTM_LENGTH + MESSAGE_HEADER_LENGTH && rest[CTM_LENGTH + 3] === 31;
  }

  /** Consume whole bzip2 records, returning the offset of the first partial one. */
  private readRecords(data: Uint8Array, offset: number, volume: Volume): number {
    this.needed = 4;
    while (!this.complete && data.length - offset >= 4) {
      // The final record's length is negated to mark the end of the volume.
      const length = Math.abs(viewOf(data).getInt32(offset));
      if (length === 0) throw new Error('Level II file is truncated');
      if (data.length - offset - 4 < length) {
        this.needed = 4 + length;
        break;
      }
      const record = bunzip2(data.subarray(offset + 4, offset + 4 + length));
      const end = this.readMessages(record, 0, volume);
      // A record holds whole messages, so a cut-off radial is damage.
      if (!this.complete && end + CTM_LENGTH + MESSAGE_HEADER_LENGTH <= record.length && record[end + CTM_LENGTH + 3] === 31) {
        throw new Error('Level II radial message is truncated');
      }
      offset += 4 + length;
    }
    return offset;
  }

  /** Consume bare messages, returning the offset of the first partial one. */
  private readStream(data: Uint8Array, offset: number, volume: Volume): number {
    const end = this.readMessages(data, offset, volume);
    const header = CTM_LENGTH + MESSAGE_HEADER_LENGTH;
    this.needed = data.length - end >= header ? messageLength(data, end) : header;
    return end;
  }

  /** Read the complete messages from `at` on; returns where it stopped. */
  private readMessages(data: Uint8Array, at: number, volume: Volume): number {
    while (!this.complete && at + CTM_LENGTH + MESSAGE_HEADER_LENGTH <= data.length) {
      const type = data[at + CTM_LENGTH + 3];
      if (type === LEGACY_RADIAL) throw new Error(OLDER_FORMAT_MESSAGE);
      const length = messageLength(data, at);
      if (at + length > data.length) break;
      if (type === 31) {
        this.readRadial(data.subarray(at + CTM_LENGTH + MESSAGE_HEADER_LENGTH, at + length), volume);
      }
      at += length;
    }
    return at;
  }

  private readRadial(message: Uint8Array, volume: Volume): void {
    const view = viewOf(message);
    const elevationNumber = view.getUint8(22);
    if (elevationNumber > this.maxElevation) {
      this.complete = true;
      return;
    }

    const radial: Radial = {
      azimuth: view.getFloat32(12),
      elevation: view.getFloat32(24),
      moments: {},
    };
    const blockCount = view.getUint16(30);
    for (let i = 0; i < blockCount; i++) {
      const at = view.getUint32(32 + 4 * i);
      if (at === 0) continue;
      const kind = text(message, at, 1);
      const name = text(message, at + 1, 3).trim();
      const block = viewOf(message.subarray(at));
      if (kind === 'D') {
        radial.moments[name] = parseMoment(block);
      } else if (name === 'VOL') {
        volume.latitude = block.getFloat32(8);
        volume.longitude = block.getFloat32(12);
        volume.height = block.getInt16(16) + block.getUint16(18);
        volume.vcp = block.getUint16(40);
      }
    }

    let sweep = this.sweeps.get(elevationNumber);
    if (!sweep) {
      sweep = {
        elevationNumber,
        elevation: radial.elevation,
        azimuthSpacing: view.getUint8(20) === 1 ? 0.5 : 1,
        radials: [],
      };
      this.sweeps.set(elevationNumber, sweep);
      volume.sweeps.push(sweep);
    }
    sweep.radials.push(radial);
  }
}

/** Bytes taken by the message starting at `at`, whose header must be present. */
function messageLength(data: Uint8Array, at: number): number {
  if (data[at + CTM_LENGTH + 3] !== 31) return FIXED_FRAME_LENGTH;
  const size = ((data[at + CTM_LENGTH]! << 8) | data[at + CTM_LENGTH + 1]!) * 2;
  if (size < MESSAGE_HEADER_LENGTH) throw new Error('Level II radial message is truncated');
  return CTM_LENGTH + size;
}

function join(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]!;
  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

const NOT_LEVEL2 = 'This is not a NEXRAD Level II archive file';

function readHeader(data: Uint8Array): Volume {
  if (text(data, 0, 8) === 'ARCHIVE2') throw new Error(OLDER_FORMAT_MESSAGE);
  if (text(data, 0, 4) !== 'AR2V') throw new Error(NOT_LEVEL2);
  const header = viewOf(data);
  const day = header.getUint32(12);
  const millis = header.getUint32(16);
  return {
    site: text(data, 20, 4),
    time: new Date((day - 1) * 86_400_000 + millis),
    latitude: NaN,
    longitude: NaN,
    height: NaN,
    vcp: 0,
    sweeps: [],
  };
}

export function parseVolume(data: Uint8Array, options: ParseOptions = {}): Volume {
  const reader = new VolumeReader(options);
  reader.push(data);
  return reader.finish();
}

/** Parse a download, cancelling it once the wanted elevations have arrived. */
export async function readVolume(body: ReadableStream<Uint8Array>, options: ParseOptions = {}): Promise<Volume> {
  const reader = new VolumeReader(options);
  const { stream: unpacked, gzipped } = await unzipped(body);
  const stream = unpacked.getReader();
  try {
    for (;;) {
      const next = await stream.read().catch((error: unknown) => {
        if (!gzipped) throw error;
        throw new Error(`Level II file is truncated or damaged (${error instanceof Error ? error.message : error})`);
      });
      if (next.done || reader.push(next.value)) break;
    }
    return reader.finish();
  } finally {
    // A no-op if the stream already ended.
    void stream.cancel().catch(() => {});
  }
}

/** The stream itself, passed through gunzip if it starts with the gzip signature. */
async function unzipped(body: ReadableStream<Uint8Array>) {
  const source = body.getReader();
  const start: Uint8Array[] = [];
  let length = 0;
  while (length < 2) {
    const { done, value } = await source.read();
    if (done) break;
    start.push(value);
    length += value.length;
  }
  const head = join(start, length);
  const gzipped = head[0] === 0x1f && head[1] === 0x8b;
  const rejoined = new ReadableStream<Uint8Array>({
    start(controller) {
      if (length > 0) controller.enqueue(head);
    },
    async pull(controller) {
      const { done, value } = await source.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel: (reason) => source.cancel(reason),
  });
  if (!gzipped) return { stream: rejoined, gzipped };
  const gunzip = new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
  return { stream: rejoined.pipeThrough(gunzip), gzipped };
}
