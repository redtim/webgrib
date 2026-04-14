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

/** Simple LRU cache with max-size eviction. */
class LruCache<V> {
  private map = new Map<string, V>();
  constructor(private maxSize: number) {}

  get(key: string): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      // Move to end (most recently used)
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    if (this.map.size > this.maxSize) {
      // Evict oldest (first key)
      const oldest = this.map.keys().next().value!;
      this.map.delete(oldest);
    }
  }
}

function serializeQuery(q: IdxQuery): string {
  const p = q.parameter instanceof RegExp ? q.parameter.source : q.parameter ?? '';
  const l = q.level instanceof RegExp ? q.level.source : q.level ?? '';
  const f = q.forecast instanceof RegExp ? q.forecast.source : q.forecast ?? '';
  return `${p}|${l}|${f}`;
}

function cacheKey(idxUrl: string, ...queries: IdxQuery[]): string {
  return idxUrl + '\0' + queries.map(serializeQuery).join('\0');
}

export class DecodeClient {
  private worker: Worker;
  private jobId = 0;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: unknown) => void }>();
  private scalarCache = new LruCache<{ field: DecodedFieldLite; grid: LambertConformalGrid }>(20);
  private pairCache = new LruCache<DecodedPair>(10);

  constructor() {
    this.worker = new Worker(new URL('./decodeWorker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (ev) => this.onMessage(ev));
    this.worker.addEventListener('error', (ev) => {
      // Worker crashed — reject all pending promises so the UI doesn't freeze
      const err = new Error(`Decode worker error: ${ev.message ?? 'unknown'}`);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  async decode(idxUrl: string, query: IdxQuery): Promise<{ field: DecodedFieldLite; grid: LambertConformalGrid }> {
    const key = cacheKey(idxUrl, query);
    const cached = this.scalarCache.get(key);
    if (cached) return cached;

    const jobId = ++this.jobId;
    const result = await new Promise<{ field: DecodedFieldLite; grid: LambertConformalGrid }>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.worker.postMessage({ type: 'decode', jobId, idxUrl, query });
    });
    this.scalarCache.set(key, result);
    return result;
  }

  async decodePair(idxUrl: string, queryU: IdxQuery, queryV: IdxQuery): Promise<DecodedPair> {
    const key = cacheKey(idxUrl, queryU, queryV);
    const cached = this.pairCache.get(key);
    if (cached) return cached;

    const jobId = ++this.jobId;
    const result = await new Promise<DecodedPair>((resolve, reject) => {
      this.pending.set(jobId, { resolve, reject });
      this.worker.postMessage({ type: 'decode-pair', jobId, idxUrl, queryU, queryV });
    });
    this.pairCache.set(key, result);
    return result;
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
