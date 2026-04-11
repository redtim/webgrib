/**
 * Main-thread client for the decode worker. Issues jobs with incrementing
 * ids, resolves promises on reply.
 */

import type { LambertConformalGrid } from '../grib2/types.js';
import type { IdxQuery } from '../grib2/idx.js';

export interface DecodedFieldLite {
  values: Float32Array;
  nx: number;
  ny: number;
  min: number;
  max: number;
}

export interface DecodedPair {
  u: DecodedFieldLite;
  v: DecodedFieldLite;
  grid: LambertConformalGrid;
}

export class DecodeClient {
  private worker: Worker;
  private jobId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();

  constructor() {
    this.worker = new Worker(new URL('./decodeWorker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (ev) => this.onMessage(ev));
  }

  decode(idxUrl: string, query: IdxQuery): Promise<{ field: DecodedFieldLite; grid: LambertConformalGrid }> {
    const jobId = ++this.jobId;
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.worker.postMessage({ type: 'decode', jobId, idxUrl, query });
    });
  }

  decodePair(idxUrl: string, queryU: IdxQuery, queryV: IdxQuery): Promise<DecodedPair> {
    const jobId = ++this.jobId;
    return new Promise((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.worker.postMessage({ type: 'decode-pair', jobId, idxUrl, queryU, queryV });
    });
  }

  private onMessage(ev: MessageEvent<any>): void {
    const { type, jobId } = ev.data;
    const p = this.pending.get(jobId);
    if (!p) return;
    this.pending.delete(jobId);
    if (type === 'decoded') {
      p.resolve({ field: ev.data.field, grid: ev.data.grid });
    } else if (type === 'decoded-pair') {
      p.resolve({ u: ev.data.u, v: ev.data.v, grid: ev.data.grid });
    } else if (type === 'error') {
      p.reject(new Error(ev.data.message));
    }
  }

  terminate(): void {
    this.worker.terminate();
  }
}
