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
import type { DecodedField, GribMessage, GridDefinition } from '../grib2/types.js';
import type { IdxQuery } from '../grib2/idx.js';

type InMsg =
  | { type: 'decode'; jobId: number; idxUrl: string; query: IdxQuery }
  | { type: 'decode-pair'; jobId: number; idxUrl: string; queryU: IdxQuery; queryV: IdxQuery }
  | { type: 'decode-ensemble'; jobId: number; idxUrls: string[]; query: IdxQuery }
  | { type: 'decode-ensemble-pair'; jobId: number; idxUrls: string[]; queryU: IdxQuery; queryV: IdxQuery };

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

async function fetchAndDecode(idxUrl: string, query: IdxQuery): Promise<{ field: DecodedField; grid: GridDefinition }> {
  const { bytes } = await fetchMessageBytes(idxUrl, query);
  const iter = walkMessages(bytes);
  const first = iter.next();
  if (first.done) throw new Error('Range-fetched bytes contained no GRIB2 message');
  const msg: GribMessage = first.value;
  const tmpl = msg.section3.grid.template;
  if (tmpl !== 30 && tmpl !== 0) {
    throw new Error(`Unsupported grid template ${tmpl} (expected 0 or 30)`);
  }
  await ensureJpxDecoder().catch(() => undefined);
  const field = await decodeMessage(msg);
  return { field, grid: msg.section3.grid };
}

function computeEnsembleStats(
  members: Float32Array[],
  length: number,
): { mean: Float32Array; spread: Float32Array } {
  const mean = new Float32Array(length);
  const spread = new Float32Array(length);
  const n = members.length;
  for (let i = 0; i < length; i++) {
    let sum = 0;
    let count = 0;
    for (let m = 0; m < n; m++) {
      const v = members[m]![i]!;
      if (Number.isFinite(v)) { sum += v; count++; }
    }
    if (count === 0) { mean[i] = NaN; spread[i] = NaN; continue; }
    const mu = sum / count;
    mean[i] = mu;
    let varSum = 0;
    for (let m = 0; m < n; m++) {
      const v = members[m]![i]!;
      if (Number.isFinite(v)) { varSum += (v - mu) * (v - mu); }
    }
    spread[i] = Math.sqrt(varSum / count);
  }
  return { mean, spread };
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
    } else if (msg.type === 'decode-ensemble') {
      const results = await Promise.all(
        msg.idxUrls.map((url) => fetchAndDecode(url, msg.query)),
      );
      const grid = results[0]!.grid;
      const length = results[0]!.field.values.length;
      const memberArrays = results.map((r) => r.field.values);
      const { mean, spread } = computeEnsembleStats(memberArrays, length);
      let mMin = Infinity, mMax = -Infinity, sMin = Infinity, sMax = -Infinity;
      for (let i = 0; i < length; i++) {
        const mv = mean[i]!; const sv = spread[i]!;
        if (mv < mMin) mMin = mv; if (mv > mMax) mMax = mv;
        if (sv < sMin) sMin = sv; if (sv > sMax) sMax = sv;
      }
      (self as unknown as Worker).postMessage(
        {
          type: 'decoded-ensemble',
          jobId: msg.jobId,
          mean: { values: mean, nx: results[0]!.field.nx, ny: results[0]!.field.ny, min: mMin, max: mMax },
          spread: { values: spread, nx: results[0]!.field.nx, ny: results[0]!.field.ny, min: sMin, max: sMax },
          grid,
        },
        { transfer: [mean.buffer, spread.buffer] },
      );
    } else if (msg.type === 'decode-ensemble-pair') {
      const uResults = await Promise.all(
        msg.idxUrls.map((url) => fetchAndDecode(url, msg.queryU)),
      );
      const vResults = await Promise.all(
        msg.idxUrls.map((url) => fetchAndDecode(url, msg.queryV)),
      );
      const grid = uResults[0]!.grid;
      const length = uResults[0]!.field.values.length;
      // Compute mean u, mean v, and speed spread
      const uMembers = uResults.map((r) => r.field.values);
      const vMembers = vResults.map((r) => r.field.values);
      const uStats = computeEnsembleStats(uMembers, length);
      const vStats = computeEnsembleStats(vMembers, length);
      // Speed spread: std dev of wind speed magnitude across members
      const speedMembers: Float32Array[] = [];
      for (let m = 0; m < uMembers.length; m++) {
        const sp = new Float32Array(length);
        for (let i = 0; i < length; i++) sp[i] = Math.hypot(uMembers[m]![i]!, vMembers[m]![i]!);
        speedMembers.push(sp);
      }
      const speedStats = computeEnsembleStats(speedMembers, length);
      const nx = uResults[0]!.field.nx;
      const ny = uResults[0]!.field.ny;
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (let i = 0; i < length; i++) {
        const u = uStats.mean[i]!, v = vStats.mean[i]!;
        if (u < uMin) uMin = u; if (u > uMax) uMax = u;
        if (v < vMin) vMin = v; if (v > vMax) vMax = v;
      }
      (self as unknown as Worker).postMessage(
        {
          type: 'decoded-ensemble-pair',
          jobId: msg.jobId,
          u: { values: uStats.mean, nx, ny, min: uMin, max: uMax },
          v: { values: vStats.mean, nx, ny, min: vMin, max: vMax },
          speedSpread: { values: speedStats.spread, nx, ny, min: speedStats.spread.reduce((a, b) => Math.min(a, b), Infinity), max: speedStats.spread.reduce((a, b) => Math.max(a, b), -Infinity) },
          grid,
        },
        { transfer: [uStats.mean.buffer, vStats.mean.buffer, speedStats.spread.buffer] },
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
