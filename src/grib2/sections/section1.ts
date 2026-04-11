import type { BinaryReader } from '../reader.js';
import type { Section1 } from '../types.js';

/**
 * Section 1 — Identification. `bodyLen` excludes the 5-byte header already
 * consumed by the caller.
 *
 * Octets (from start of section, 1-indexed per spec):
 *   1–4  length
 *   5    number (= 1)
 *   6–7  originating center
 *   8–9  originating subcenter
 *  10    GRIB master tables version
 *  11    GRIB local tables version
 *  12    significance of reference time
 *  13–14 year
 *  15    month
 *  16    day
 *  17    hour
 *  18    minute
 *  19    second
 *  20    production status of processed data
 *  21    type of processed data
 */
export function parseSection1(r: BinaryReader, bodyLen: number): Section1 {
  const start = r.pos;
  const originatingCenter = r.uint16();
  const originatingSubCenter = r.uint16();
  const masterTablesVersion = r.uint8();
  const localTablesVersion = r.uint8();
  const significanceOfReferenceTime = r.uint8();
  const year = r.uint16();
  const month = r.uint8();
  const day = r.uint8();
  const hour = r.uint8();
  const minute = r.uint8();
  const second = r.uint8();
  const productionStatus = r.uint8();
  const typeOfProcessedData = r.uint8();
  // Ignore any trailing reserved bytes
  r.pos = start + bodyLen;

  return {
    originatingCenter,
    originatingSubCenter,
    masterTablesVersion,
    localTablesVersion,
    significanceOfReferenceTime,
    referenceTime: { year, month, day, hour, minute, second },
    productionStatus,
    typeOfProcessedData,
  };
}
