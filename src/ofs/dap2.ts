/**
 * Minimal DAP2 binary (`.dods`) parser for OPeNDAP responses.
 *
 * DAP2 binary format (after the ASCII DDS header):
 *   - Arrays are preceded by two big-endian uint32 values: the array length
 *     (repeated twice), followed by the raw data in XDR format.
 *   - Float32 values are big-endian IEEE 754.
 *   - The DDS header is separated from the binary data by "\nData:\n".
 */

/** Parse a DAP2 `.dods` response into named Float32Arrays. */
export function parseDap2(
  buffer: ArrayBuffer,
  variableNames: string[],
): Map<string, { data: Float32Array; shape: number[] }> {
  const bytes = new Uint8Array(buffer);

  // Find the "Data:\n" separator between the DDS header and binary data.
  const dataMarker = findDataMarker(bytes);
  if (dataMarker < 0) throw new Error('DAP2: could not find "Data:" separator');

  // Parse the DDS header to get array shapes, types, and ORDER (binary follows DDS order).
  const ddsText = new TextDecoder().decode(bytes.subarray(0, dataMarker));
  const varInfo = parseDds(ddsText, variableNames);
  const ddsOrder = parseDdsOrder(ddsText, variableNames);

  // Parse binary section — must follow DDS declaration order
  const view = new DataView(buffer, dataMarker);
  let offset = 0;
  const result = new Map<string, { data: Float32Array; shape: number[] }>();

  for (const name of ddsOrder) {
    const info = varInfo.get(name);
    if (!info) throw new Error(`DAP2: variable "${name}" not found in DDS`);

    const totalElements = info.shape.reduce((a, b) => a * b, 1);

    // Each array is preceded by two uint32 length fields
    const len1 = view.getUint32(offset, false); offset += 4;
    const len2 = view.getUint32(offset, false); offset += 4;
    if (len1 !== len2) {
      throw new Error(`DAP2: mismatched duplicated array lengths for "${name}": ${len1} !== ${len2}`);
    }

    if (len1 !== totalElements) {
      throw new Error(`DAP2: expected ${totalElements} elements for "${name}", got ${len1}`);
    }

    // Read values based on DDS type — always output as Float32Array
    const data = new Float32Array(totalElements);
    if (info.dtype === 'Float64') {
      for (let i = 0; i < totalElements; i++) {
        data[i] = view.getFloat64(offset, false);
        offset += 8;
      }
    } else if (info.dtype === 'Int32') {
      for (let i = 0; i < totalElements; i++) {
        data[i] = view.getInt32(offset, false);
        offset += 4;
      }
    } else if (info.dtype === 'Int16') {
      // XDR pads Int16 to 4 bytes (2 bytes data + 2 bytes padding)
      for (let i = 0; i < totalElements; i++) {
        data[i] = view.getInt16(offset, false);
        offset += 4;
      }
    } else {
      // Float32 (default)
      for (let i = 0; i < totalElements; i++) {
        data[i] = view.getFloat32(offset, false);
        offset += 4;
      }
    }

    result.set(name, { data, shape: info.shape });
  }

  return result;
}

/** Find byte offset right after "Data:\n" in the buffer. */
function findDataMarker(bytes: Uint8Array): number {
  // Look for \nData:\n (0x0A, 0x44, 0x61, 0x74, 0x61, 0x3A, 0x0A)
  const marker = [0x0A, 0x44, 0x61, 0x74, 0x61, 0x3A, 0x0A];
  outer: for (let i = 0; i < bytes.length - marker.length; i++) {
    for (let j = 0; j < marker.length; j++) {
      if (bytes[i + j] !== marker[j]) continue outer;
    }
    return i + marker.length;
  }
  return -1;
}

/**
 * Parse variable shapes and types from DDS text. Looks for lines like:
 *   Float32 u_eastward[time = 1][s_rho = 1][eta_rho = 329][xi_rho = 553];
 *   Float64 Latitude[ny = 329][nx = 553];
 */
function parseDds(dds: string, names: string[]): Map<string, { shape: number[]; dtype: string }> {
  const result = new Map<string, { shape: number[]; dtype: string }>();
  for (const name of names) {
    // Match: Float32/Float64 varname[dim1 = N][dim2 = M]...;
    const re = new RegExp(`(Float32|Float64|Int32|Int16)\\s+${escapeRegex(name)}((?:\\[[^\\]]+\\])+)`, 'm');
    const m = dds.match(re);
    if (!m) continue;
    const dtype = m[1]!;
    const dims: number[] = [];
    const dimRe = /\[(?:\w+)\s*=\s*(\d+)\]/g;
    let dm: RegExpExecArray | null;
    while ((dm = dimRe.exec(m[2]!)) !== null) {
      dims.push(parseInt(dm[1]!, 10));
    }
    result.set(name, { shape: dims, dtype });
  }
  return result;
}

/** Get variable names in DDS declaration order (binary data follows this order). */
function parseDdsOrder(dds: string, requestedNames: string[]): string[] {
  const nameSet = new Set(requestedNames);
  const ordered: string[] = [];
  // Match type declarations: Float32 varname[...] or Float64 varname[...]
  const re = /(?:Float32|Float64|Int32|Int16)\s+(\w+)\s*\[/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dds)) !== null) {
    if (nameSet.has(m[1]!)) ordered.push(m[1]!);
  }
  return ordered;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
