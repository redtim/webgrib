/**
 * Big-endian binary reader over a DataView. GRIB2 is all big-endian.
 *
 * Conventions: all uint{N} and int{N} read and advance the cursor.
 * peek{N} reads without advancing. All offsets are absolute into the underlying
 * ArrayBuffer and the reader maintains its own cursor.
 */
export class BinaryReader {
  readonly view: DataView;
  readonly bytes: Uint8Array;
  pos: number;

  constructor(buffer: ArrayBuffer | Uint8Array, byteOffset = 0, byteLength?: number) {
    if (buffer instanceof Uint8Array) {
      this.view = new DataView(buffer.buffer, buffer.byteOffset + byteOffset, byteLength ?? buffer.byteLength - byteOffset);
      this.bytes = new Uint8Array(buffer.buffer, buffer.byteOffset + byteOffset, byteLength ?? buffer.byteLength - byteOffset);
    } else {
      this.view = new DataView(buffer, byteOffset, byteLength ?? buffer.byteLength - byteOffset);
      this.bytes = new Uint8Array(buffer, byteOffset, byteLength ?? buffer.byteLength - byteOffset);
    }
    this.pos = 0;
  }

  get remaining(): number { return this.view.byteLength - this.pos; }
  get length(): number { return this.view.byteLength; }

  seek(p: number): void { this.pos = p; }
  skip(n: number): void { this.pos += n; }

  uint8(): number { return this.view.getUint8(this.pos++); }
  int8(): number { return this.view.getInt8(this.pos++); }

  uint16(): number { const v = this.view.getUint16(this.pos, false); this.pos += 2; return v; }
  int16(): number { const v = this.view.getInt16(this.pos, false); this.pos += 2; return v; }

  uint32(): number { const v = this.view.getUint32(this.pos, false); this.pos += 4; return v; }
  int32(): number { const v = this.view.getInt32(this.pos, false); this.pos += 4; return v; }

  /** Read a 64-bit unsigned big-endian integer as Number (lossy above 2^53). */
  uint64(): number {
    const hi = this.view.getUint32(this.pos, false);
    const lo = this.view.getUint32(this.pos + 4, false);
    this.pos += 8;
    return hi * 0x100000000 + lo;
  }

  /**
   * GRIB2 uses "sign-magnitude" integers for several negative-capable fields
   * (octets with high bit as sign). This decodes one: N bytes, top bit sign.
   *
   * Built on multiplication instead of `<<`, which in JS is signed-32-bit and
   * silently corrupts values whose magnitude uses bit 31.
   */
  signedMagnitude(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + this.view.getUint8(this.pos + i);
    this.pos += n;
    const signMask = Math.pow(2, n * 8 - 1);
    if (v >= signMask) return -(v - signMask);
    return v;
  }

  /** Read N raw bytes (no copy — view into underlying buffer). */
  sliceView(n: number): Uint8Array {
    const out = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Read N raw bytes into a fresh Uint8Array. */
  slice(n: number): Uint8Array {
    const out = this.bytes.slice(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  ascii(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += String.fromCharCode(this.view.getUint8(this.pos + i));
    this.pos += n;
    return s;
  }
}

/**
 * Bit-level reader used for unpacking GRIB2 data templates. Reads from a byte
 * array, MSB-first within each byte. Bit offsets cross byte boundaries freely.
 *
 * This is the hot path for simple/complex packing — keep it monomorphic.
 */
export class BitReader {
  private readonly buf: Uint8Array;
  private bitPos: number;

  constructor(buf: Uint8Array, startBit = 0) {
    this.buf = buf;
    this.bitPos = startBit;
  }

  /** Read `nBits` bits as an unsigned integer. nBits must be in [0, 32]. */
  readBits(nBits: number): number {
    if (nBits === 0) return 0;
    let value = 0;
    let remaining = nBits;
    let bitPos = this.bitPos;
    const buf = this.buf;
    while (remaining > 0) {
      const byteIdx = bitPos >>> 3;
      const bitInByte = bitPos & 7;
      const bitsLeftInByte = 8 - bitInByte;
      const take = remaining < bitsLeftInByte ? remaining : bitsLeftInByte;
      const shift = bitsLeftInByte - take;
      const mask = (1 << take) - 1;
      value = (value << take) | ((buf[byteIdx]! >> shift) & mask);
      bitPos += take;
      remaining -= take;
    }
    this.bitPos = bitPos;
    return value;
  }

  get position(): number { return this.bitPos; }
  set position(p: number) { this.bitPos = p; }

  align(): void {
    this.bitPos = (this.bitPos + 7) & ~7;
  }
}
