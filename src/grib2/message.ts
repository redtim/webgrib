/**
 * Top-level message walker: given a buffer containing one or more concatenated
 * GRIB2 messages, yields parsed {@link GribMessage} records.
 *
 * GRIB2 structure per message:
 *   §0 indicator  (16 bytes, fixed) — "GRIB" + reserved + discipline + edition + totalLength
 *   §1 identification
 *   §2 local use (optional)
 *   §3 grid definition
 *   §4 product definition
 *   §5 data representation
 *   §6 bitmap
 *   §7 data
 *   §8 end marker ("7777")
 *
 * Sections 2..7 each start with a 4-byte length followed by a 1-byte section
 * number. A single message can contain multiple §4/§5/§6/§7 groups (repeated
 * products on the same grid), but we treat those as separate logical messages
 * at the level of our API — the walker emits one record per §7 encountered.
 */

import { BinaryReader } from './reader.js';
import { parseSection1 } from './sections/section1.js';
import { parseSection3 } from './sections/section3.js';
import { parseSection4 } from './sections/section4.js';
import { parseSection5 } from './sections/section5.js';
import { parseSection6 } from './sections/section6.js';
import type { GribMessage, Section1, Section3GDS, Section4, Section5, Section6 } from './types.js';

export interface WalkOptions {
  /** Stop after N messages. Default: unlimited. */
  limit?: number;
  /** Keep parsing past corrupt section boundaries. Default: false. */
  tolerant?: boolean;
}

export function* walkMessages(buf: ArrayBuffer | Uint8Array, opts: WalkOptions = {}): Generator<GribMessage> {
  const reader = new BinaryReader(buf);
  let emitted = 0;
  const limit = opts.limit ?? Infinity;

  while (reader.remaining >= 16 && emitted < limit) {
    // §0 — Indicator
    const messageStart = reader.pos;
    const magic = reader.ascii(4);
    if (magic !== 'GRIB') {
      if (opts.tolerant) {
        reader.pos = messageStart + 1;
        continue;
      }
      throw new Error(`Expected GRIB magic at offset ${messageStart}, got "${magic}"`);
    }
    reader.skip(2); // reserved
    const discipline = reader.uint8();
    const edition = reader.uint8();
    if (edition !== 2) {
      throw new Error(`Unsupported GRIB edition ${edition} (this library only handles GRIB2)`);
    }
    const totalLength = reader.uint64();
    const messageEnd = messageStart + totalLength;

    // §1 — Identification
    const section1Len = reader.uint32();
    const section1Num = reader.uint8();
    if (section1Num !== 1) throw new Error(`Expected section 1, got ${section1Num}`);
    const section1: Section1 = parseSection1(reader, section1Len - 5);

    // The remaining sections form zero or more (§2?, §3, §4, §5, §6, §7) groups
    // before §8. Per spec, once §3 is seen later §3s replace it for subsequent
    // products; ditto §4. We keep the most recent of each.
    let currentGDS: Section3GDS | null = null;
    let currentS4: Section4 | null = null;
    let currentS5: Section5 | null = null;
    let currentS6: Section6 | null = null;

    while (reader.pos < messageEnd - 4) {
      // Peek section length + number
      const sectionLen = reader.uint32();
      const sectionNum = reader.uint8();

      if (sectionLen === 0x37373737 && sectionNum === 0x37) {
        // That's "7777" in ASCII — we accidentally read the end marker as a length.
        // Rewind and break.
        reader.pos -= 5;
        break;
      }

      const bodyStart = reader.pos;
      const bodyLen = sectionLen - 5;

      switch (sectionNum) {
        case 2: {
          // Local use section — skip entirely.
          reader.skip(bodyLen);
          break;
        }
        case 3: {
          currentGDS = parseSection3(reader, bodyLen);
          break;
        }
        case 4: {
          currentS4 = parseSection4(reader, bodyLen);
          break;
        }
        case 5: {
          currentS5 = parseSection5(reader, bodyLen);
          break;
        }
        case 6: {
          currentS6 = parseSection6(reader, bodyLen);
          break;
        }
        case 7: {
          if (!currentGDS || !currentS4 || !currentS5 || !currentS6) {
            throw new Error(`Section 7 encountered before §3/§4/§5/§6 at offset ${bodyStart}`);
          }
          const data = reader.slice(bodyLen);
          const msg: GribMessage = {
            byteOffset: messageStart,
            byteLength: totalLength,
            section0: { discipline, edition, totalLength },
            section1,
            section3: currentGDS,
            section4: currentS4,
            section5: currentS5,
            section6: currentS6,
            section7: { data },
          };
          yield msg;
          emitted++;
          if (emitted >= limit) return;
          break;
        }
        case 8: {
          // End section — ensure we see "7777".
          reader.pos = bodyStart; // rewind
          break;
        }
        default: {
          if (opts.tolerant) {
            reader.skip(bodyLen);
          } else {
            throw new Error(`Unknown section number ${sectionNum} at offset ${bodyStart}`);
          }
        }
      }

      // Advance to the stated end of the section in case the parser under/over-read.
      reader.pos = bodyStart + bodyLen;
    }

    // §8 — End marker "7777"
    const end = reader.ascii(4);
    if (end !== '7777') {
      if (!opts.tolerant) throw new Error(`Expected 7777 end marker, got "${end}"`);
    }

    // Defensive: snap to stated message end in case totalLength disagreed.
    reader.pos = messageEnd;
  }
}
