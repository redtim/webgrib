/**
 * Minimal bzip2 decompressor. NEXRAD Level 2 files are a series of independent
 * bzip2 streams and browsers have no built-in decoder for them.
 *
 * Decodes one complete stream: Huffman → move-to-front / zero-run expansion →
 * inverse Burrows-Wheeler → initial run-length expansion, checking block CRCs.
 * The long-obsolete "randomised block" mode is not supported.
 */

const MAX_CODE_LENGTH = 20;
const GROUP_SIZE = 50;

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 24;
    for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1;
    table[i] = c;
  }
  return table;
})();

class BitStream {
  private pos = 0;
  private buf = 0;
  private count = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Read up to 24 bits, most significant first. */
  read(n: number): number {
    while (this.count < n) {
      if (this.pos >= this.data.length) throw new Error('bzip2: unexpected end of data');
      this.buf = (this.buf << 8) | this.data[this.pos++]!;
      this.count += 8;
    }
    this.count -= n;
    return (this.buf >>> this.count) & ((1 << n) - 1);
  }

  read32(): number {
    return ((this.read(16) << 16) | this.read(16)) >>> 0;
  }
}

class Output {
  private buf = new Uint8Array(1 << 16);
  length = 0;

  push(byte: number, times: number): void {
    const end = this.length + times;
    if (end > this.buf.length) {
      const grown = new Uint8Array(Math.max(end, this.buf.length * 2));
      grown.set(this.buf.subarray(0, this.length));
      this.buf = grown;
    }
    if (times === 1) this.buf[this.length] = byte;
    else this.buf.fill(byte, this.length, end);
    this.length = end;
  }

  bytes(): Uint8Array {
    return this.buf.slice(0, this.length);
  }
}

/** Canonical Huffman decoding tables for one code. */
interface HuffmanTable {
  minLength: number;
  /** Largest code value of each length, or -1 when none. */
  limit: Int32Array;
  /** Subtract from a code to get its index into `symbols`. */
  base: Int32Array;
  symbols: Uint16Array;
}

function buildTable(lengths: Uint8Array): HuffmanTable {
  const limit = new Int32Array(MAX_CODE_LENGTH + 1).fill(-1);
  const base = new Int32Array(MAX_CODE_LENGTH + 1);
  const symbols = new Uint16Array(lengths.length);
  let minLength = MAX_CODE_LENGTH;
  let code = 0;
  let index = 0;
  for (let len = 1; len <= MAX_CODE_LENGTH; len++) {
    const first = index;
    for (let s = 0; s < lengths.length; s++) {
      if (lengths[s] === len) symbols[index++] = s;
    }
    const n = index - first;
    base[len] = code - first;
    if (n > 0) {
      limit[len] = code + n - 1;
      minLength = Math.min(minLength, len);
    }
    code = (code + n) << 1;
  }
  return { minLength, limit, base, symbols };
}

function decodeSymbol(bits: BitStream, table: HuffmanTable): number {
  let len = table.minLength;
  let code = bits.read(len);
  while (code > table.limit[len]!) {
    if (++len > MAX_CODE_LENGTH) throw new Error('bzip2: invalid Huffman code');
    code = (code << 1) | bits.read(1);
  }
  const symbol = table.symbols[code - table.base[len]!];
  if (symbol === undefined) throw new Error('bzip2: invalid Huffman code');
  return symbol;
}

/** Decode one block into `out`, returning its CRC after checking it. */
function decodeBlock(bits: BitStream, tt: Uint32Array, out: Output): number {
  const storedCrc = bits.read32();
  if (bits.read(1)) throw new Error('bzip2: randomised blocks are not supported');
  const origPtr = bits.read(24);

  // Which byte values occur in this block.
  const used: number[] = [];
  const ranges = bits.read(16);
  for (let i = 0; i < 16; i++) {
    if (!(ranges & (0x8000 >>> i))) continue;
    const mask = bits.read(16);
    for (let j = 0; j < 16; j++) {
      if (mask & (0x8000 >>> j)) used.push(i * 16 + j);
    }
  }
  if (used.length === 0) throw new Error('bzip2: block uses no symbols');
  const alphaSize = used.length + 2;
  const endOfBlock = alphaSize - 1;

  const groupCount = bits.read(3);
  if (groupCount < 2 || groupCount > 6) throw new Error('bzip2: bad Huffman group count');
  const selectorCount = bits.read(15);
  if (selectorCount < 1) throw new Error('bzip2: no selectors');
  const selectors = new Uint8Array(selectorCount);
  const groupOrder = [0, 1, 2, 3, 4, 5];
  for (let i = 0; i < selectorCount; i++) {
    let j = 0;
    while (bits.read(1)) {
      if (++j >= groupCount) throw new Error('bzip2: bad selector');
    }
    const group = groupOrder[j]!;
    groupOrder.copyWithin(1, 0, j);
    groupOrder[0] = group;
    selectors[i] = group;
  }

  const tables: HuffmanTable[] = [];
  const lengths = new Uint8Array(alphaSize);
  for (let g = 0; g < groupCount; g++) {
    let len = bits.read(5);
    for (let s = 0; s < alphaSize; s++) {
      for (;;) {
        if (len < 1 || len > MAX_CODE_LENGTH) throw new Error('bzip2: bad code length');
        if (!bits.read(1)) break;
        len += bits.read(1) ? -1 : 1;
      }
      lengths[s] = len;
    }
    tables.push(buildTable(lengths));
  }

  // Huffman symbols → move-to-front indices and zero runs → BWT output.
  const mtf = Uint8Array.from(used);
  const counts = new Int32Array(256);
  let n = 0;
  let selector = 0;
  let left = 0;
  let table = tables[0]!;
  let run = 0;
  let runUnit = 1;
  for (;;) {
    if (left === 0) {
      if (selector >= selectorCount) throw new Error('bzip2: ran out of selectors');
      table = tables[selectors[selector++]!]!;
      left = GROUP_SIZE;
    }
    left--;
    const symbol = decodeSymbol(bits, table);

    if (symbol <= 1) {
      run += runUnit << symbol;
      runUnit <<= 1;
      if (run > tt.length) throw new Error('bzip2: run exceeds block size');
      continue;
    }
    if (run > 0) {
      const byte = mtf[0]!;
      if (n + run > tt.length) throw new Error('bzip2: block overflow');
      tt.fill(byte, n, n + run);
      counts[byte]! += run;
      n += run;
      run = 0;
      runUnit = 1;
    }
    if (symbol === endOfBlock) break;

    const index = symbol - 1;
    const byte = mtf[index]!;
    mtf.copyWithin(1, 0, index);
    mtf[0] = byte;
    if (n >= tt.length) throw new Error('bzip2: block overflow');
    tt[n++] = byte;
    counts[byte]!++;
  }
  if (origPtr >= n) throw new Error('bzip2: bad block origin');

  // Inverse BWT: pack each successor index above the byte already in tt.
  let total = 0;
  for (let b = 0; b < 256; b++) {
    const c = counts[b]!;
    counts[b] = total;
    total += c;
  }
  for (let i = 0; i < n; i++) {
    const byte = tt[i]! & 0xff;
    const slot = counts[byte]!++;
    tt[slot] = (tt[slot]! | (i << 8)) >>> 0;
  }

  // Walk the chain, expanding the run-length coding applied before the BWT.
  let crc = -1;
  let pos = tt[origPtr]! >>> 8;
  let previous = -1;
  let repeats = 0;
  for (let k = 0; k < n; k++) {
    const entry = tt[pos]!;
    pos = entry >>> 8;
    const byte = entry & 0xff;
    let value = byte;
    let times = 1;
    if (repeats === 4) {
      // After four equal bytes comes a count of further copies.
      value = previous;
      times = byte;
      repeats = 0;
    } else if (byte === previous) {
      repeats++;
    } else {
      previous = byte;
      repeats = 1;
    }
    if (times > 0) {
      out.push(value, times);
      for (let t = 0; t < times; t++) crc = (crc << 8) ^ CRC_TABLE[(crc >>> 24) ^ value]!;
    }
  }
  if (~crc >>> 0 !== storedCrc) throw new Error('bzip2: block CRC mismatch');
  return storedCrc;
}

/** Decompress a single bzip2 stream. Bytes after the stream are ignored. */
export function bunzip2(data: Uint8Array): Uint8Array {
  const bits = new BitStream(data);
  if (data.length < 4 || data[0] !== 0x42 || data[1] !== 0x5a || data[2] !== 0x68) {
    throw new Error('bzip2: missing BZh header');
  }
  bits.read(24);
  const level = bits.read(8) - 0x30;
  if (level < 1 || level > 9) throw new Error('bzip2: bad block size');

  const tt = new Uint32Array(level * 100_000);
  const out = new Output();
  let streamCrc = 0;
  for (;;) {
    const high = bits.read(24);
    const low = bits.read(24);
    if (high === 0x314159 && low === 0x265359) {
      const blockCrc = decodeBlock(bits, tt, out);
      streamCrc = (((streamCrc << 1) | (streamCrc >>> 31)) ^ blockCrc) >>> 0;
    } else if (high === 0x177245 && low === 0x385090) {
      if (bits.read32() !== streamCrc) throw new Error('bzip2: stream CRC mismatch');
      return out.bytes();
    } else {
      throw new Error('bzip2: bad block header');
    }
  }
}
