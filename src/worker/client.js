/**
 * Main-thread client for the decode worker. Issues jobs with incrementing
 * ids, resolves promises on reply.
 */
/** Simple LRU cache with max-size eviction. */
class LruCache {
    maxSize;
    map = new Map();
    constructor(maxSize) {
        this.maxSize = maxSize;
    }
    get(key) {
        const v = this.map.get(key);
        if (v !== undefined) {
            // Move to end (most recently used)
            this.map.delete(key);
            this.map.set(key, v);
        }
        return v;
    }
    set(key, value) {
        this.map.delete(key);
        this.map.set(key, value);
        if (this.map.size > this.maxSize) {
            // Evict oldest (first key)
            const oldest = this.map.keys().next().value;
            this.map.delete(oldest);
        }
    }
}
function serializeQuery(q) {
    const p = q.parameter instanceof RegExp ? q.parameter.source : q.parameter ?? '';
    const l = q.level instanceof RegExp ? q.level.source : q.level ?? '';
    const f = q.forecast instanceof RegExp ? q.forecast.source : q.forecast ?? '';
    return `${p}|${l}|${f}`;
}
function cacheKey(idxUrl, ...queries) {
    return idxUrl + '\0' + queries.map(serializeQuery).join('\0');
}
export class DecodeClient {
    worker;
    jobId = 0;
    pending = new Map();
    scalarCache = new LruCache(20);
    pairCache = new LruCache(10);
    constructor() {
        this.worker = new Worker(new URL('./decodeWorker.ts', import.meta.url), { type: 'module' });
        this.worker.addEventListener('message', (ev) => this.onMessage(ev));
    }
    async decode(idxUrl, query) {
        const key = cacheKey(idxUrl, query);
        const cached = this.scalarCache.get(key);
        if (cached)
            return cached;
        const jobId = ++this.jobId;
        const result = await new Promise((resolve, reject) => {
            this.pending.set(jobId, { resolve, reject });
            this.worker.postMessage({ type: 'decode', jobId, idxUrl, query });
        });
        this.scalarCache.set(key, result);
        return result;
    }
    async decodePair(idxUrl, queryU, queryV) {
        const key = cacheKey(idxUrl, queryU, queryV);
        const cached = this.pairCache.get(key);
        if (cached)
            return cached;
        const jobId = ++this.jobId;
        const result = await new Promise((resolve, reject) => {
            this.pending.set(jobId, { resolve, reject });
            this.worker.postMessage({ type: 'decode-pair', jobId, idxUrl, queryU, queryV });
        });
        this.pairCache.set(key, result);
        return result;
    }
    onMessage(ev) {
        const { type, jobId } = ev.data;
        const p = this.pending.get(jobId);
        if (!p)
            return;
        this.pending.delete(jobId);
        if (type === 'decoded') {
            p.resolve({ field: ev.data.field, grid: ev.data.grid });
        }
        else if (type === 'decoded-pair') {
            p.resolve({ u: ev.data.u, v: ev.data.v, grid: ev.data.grid });
        }
        else if (type === 'error') {
            p.reject(new Error(ev.data.message));
        }
    }
    terminate() {
        this.worker.terminate();
    }
}
