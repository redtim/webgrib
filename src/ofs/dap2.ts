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

  // Parse the DDS header to get array shapes.
  const ddsText = new TextDecoder().decode(bytes.subarray(0, dataMarker));
  const shapes = parseDds(ddsText, variableNames);

  // Parse binary section
  const view = new DataView(buffer, dataMarker);
  let offset = 0;
  const result = new Map<string, { data: Float32Array; shape: number[] }>();

  for (const name of variableNames) {
    const shape = shapes.get(name);
    if (!shape) throw new Error(`DAP2: variable "${name}" not found in DDS`);

    const totalElements = shape.reduce((a, b) => a * b, 1);

    // Each array is preceded by two uint32 length fields
    const len1 = view.getUint32(offset, false); offset += 4;
    const _len2 = view.getUint32(offset, false); offset += 4;

    if (len1 !== totalElements) {
      throw new Error(`DAP2: expected ${totalElements} elements for "${name}", got ${len1}`);
    }

    // Read big-endian float32 values
    const data = new Float32Array(totalElements);
    for (let i = 0; i < totalElements; i++) {
      data[i] = view.getFloat32(offset, false);
      offset += 4;
    }

    result.set(name, { data, shape });
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
 * Parse variable shapes from DDS text. Looks for lines like:
 *   Float32 u_eastward[time = 1][s_rho = 1][eta_rho = 329][xi_rho = 553];
 */
function parseDds(dds: string, names: string[]): Map<string, number[]> {
  const result = new Map<string, number[]>();
  for (const name of names) {
    // Match: Float32 varname[dim1 = N][dim2 = M]...;
    const re = new RegExp(`\\b${escapeRegex(name)}((?:\\[[^\\]]+\\])+)`, 'm');
    const m = dds.match(re);
    if (!m) continue;
    const dims: number[] = [];
    const dimRe = /\[(?:\w+)\s*=\s*(\d+)\]/g;
    let dm: RegExpExecArray | null;
    while ((dm = dimRe.exec(m[1]!)) !== null) {
      dims.push(parseInt(dm[1]!, 10));
    }
    result.set(name, dims);
  }
  return result;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
