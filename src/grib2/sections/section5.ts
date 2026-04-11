import type { BinaryReader } from '../reader.js';
import type { Section5 } from '../types.js';

/**
 * Section 5 — Data Representation. We read the number of values and the
 * template number, and then snapshot the entire template body as a raw slice;
 * actual template interpretation happens in the DRS dispatcher (`unpack.ts`)
 * so the §5 parser doesn't need to know every packing format.
 *
 *    1–4  length
 *    5    number (=5)
 *    6–9  number of data points where one or more values are specified
 *   10–11 data representation template number
 *   12+   template
 */
export function parseSection5(r: BinaryReader, bodyLen: number): Section5 {
  const start = r.pos;
  const numberOfValues = r.uint32();
  const template = r.uint16();
  const templateBodyLen = bodyLen - (r.pos - start);
  const body = r.slice(templateBodyLen);
  return { numberOfValues, template, body };
}
