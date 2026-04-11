/**
 * Decode worker. Main thread posts a fetch-and-decode job; we stream the
 * idx, range-fetch the message(s), run the decoder pipeline, and post the
 * resulting Float32Array back as a transferable to keep the main thread fast.
 *
 * Message protocol (main → worker):
 *
 *   { type: 'decode', jobId, idxUrl, query: IdxQuery }
 *   { type: 'decode-pair', jobId, idxUrl, queryU, queryV }  // for wind layers
 *
 * Reply (worker → main):
 *
 *   { type: 'decoded', jobId, field: SerializedField, grid: GridSummary }
 *   { type: 'decoded-pair', jobId, u, v, grid }
 *   { type: 'error', jobId, message }
 */

import { decodeMessage, ensureJpxDecoder, fetchMessageBytes, walkMessages } from '../grib2/index.js';
import type { DecodedField, GribMessage, LambertConformalGrid } from '../grib2/types.js';
import type { IdxQuery } from '../grib2/idx.js';

type InMsg =
  | { type: 'decode'; jobId: number; idxUrl: string; query: IdxQuery }
  | { type: 'decode-pair'; jobId: number; idxUrl: string; queryU: IdxQuery; queryV: IdxQuery };

interface SerializedField {
  values: Float32Array;
  nx: number;
  ny: number;
  min: number;
  max: number;
}

function serializeField(f: DecodedField): SerializedField {
  return { values: f.values, nx: f.nx, ny: f.ny, min: f.min, max: f.max };
}

async function fetchAndDecode(idxUrl: string, query: IdxQuery): Promise<{ field: DecodedField; grid: LambertConformalGrid }> {
  const { bytes } = await fetchMessageBytes(idxUrl, query);
  const iter = walkMessages(bytes);
  const first = iter.next();
  if (first.done) throw new Error('Range-fetched bytes contained no GRIB2 message');
  const msg: GribMessage = first.value;
  if (msg.section3.grid.template !== 30) {
    throw new Error(`Expected Lambert Conformal grid (template 3.30), got template ${msg.section3.grid.template}`);
  }
  await ensureJpxDecoder().catch(() => undefined);
  const field = await decodeMessage(msg);
  return { field, grid: msg.section3.grid as LambertConformalGrid };
}

self.addEventListener('message', async (ev: MessageEvent<InMsg>) => {
  const msg = ev.data;
  try {
    if (msg.type === 'decode') {
      const { field, grid } = await fetchAndDecode(msg.idxUrl, msg.query);
      (self as unknown as Worker).postMessage(
        { type: 'decoded', jobId: msg.jobId, field: serializeField(field), grid },
        { transfer: [field.values.buffer] },
      );
    } else if (msg.type === 'decode-pair') {
      const [u, v] = await Promise.all([
        fetchAndDecode(msg.idxUrl, msg.queryU),
        fetchAndDecode(msg.idxUrl, msg.queryV),
      ]);
      (self as unknown as Worker).postMessage(
        {
          type: 'decoded-pair',
          jobId: msg.jobId,
          u: serializeField(u.field),
          v: serializeField(v.field),
          grid: u.grid,
        },
        { transfer: [u.field.values.buffer, v.field.values.buffer] },
      );
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({
      type: 'error',
      jobId: msg.jobId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

// Let the bundler know this is a module worker.
export {};
