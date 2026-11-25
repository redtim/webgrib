/** Loads a list of scans through the decode worker, a few at a time. */

import { OLDER_FORMAT_MESSAGE } from './level2.js';
import type { Scan, WorkerReply } from './worker.js';

export interface WorkerLike {
  postMessage(message: { key: string }): void;
  terminate(): void;
  onmessage: ((event: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((event: ErrorEvent) => void) | null;
}

/** How a load ended. `done` may still include individual failures. */
export type LoadOutcome = 'done' | 'cancelled' | 'out-of-memory' | 'older-format';

export interface LoadHandlers {
  scan(scan: Scan): void;
  failed(key: string, message: string): void;
}

/** What to tell the viewer about a finished load; empty if all went well. */
export function outcomeMessage(outcome: LoadOutcome, loaded: number, requested: number, skipped: number): string {
  const progress = `${loaded} of ${requested} scans`;
  if (outcome === 'out-of-memory') return `Stopped at ${progress}: out of memory`;
  if (outcome === 'older-format') return OLDER_FORMAT_MESSAGE;
  if (outcome === 'cancelled') return `Loading cancelled at ${progress}`;
  if (skipped === 0) return '';
  return `${skipped} ${skipped === 1 ? 'scan' : 'scans'} could not be loaded and ${skipped === 1 ? 'was' : 'were'} skipped`;
}

export class ScanLoader {
  private worker: WorkerLike | null = null;
  /** Ends the load in progress, if any. */
  private stop: (() => void) | null = null;

  constructor(private readonly createWorker: () => WorkerLike, private readonly concurrency = 3) {}

  /** Load `keys` in order, abandoning any load already running. */
  load(keys: string[], handlers: LoadHandlers): Promise<LoadOutcome> {
    this.cancel();
    return new Promise((resolve) => {
      const queue = [...keys];
      const inFlight = new Set<string>();
      let ended = false;

      const end = (outcome: LoadOutcome) => {
        if (ended) return;
        ended = true;
        this.stop = null;
        // Terminating is the only way to abort downloads still running.
        if (outcome !== 'done') this.discardWorker();
        resolve(outcome);
      };

      const fill = () => {
        if (ended) return;
        while (inFlight.size < this.concurrency && queue.length > 0) {
          const key = queue.shift()!;
          inFlight.add(key);
          this.worker!.postMessage({ key });
        }
        if (inFlight.size === 0) end('done');
      };

      const attach = () => {
        const worker = (this.worker ??= this.createWorker());
        worker.onmessage = ({ data }) => {
          const key = 'scan' in data ? data.scan.key : data.key;
          if (ended || !inFlight.delete(key)) return;
          if ('scan' in data) handlers.scan(data.scan);
          else if (data.outOfMemory) return end('out-of-memory');
          else if (data.error === OLDER_FORMAT_MESSAGE) return end('older-format');
          else handlers.failed(key, data.error);
          fill();
        };
        worker.onerror = (event) => {
          if (ended) return;
          for (const key of inFlight) handlers.failed(key, event.message || 'Radar decoder crashed');
          inFlight.clear();
          this.discardWorker();
          attach();
          fill();
        };
      };

      this.stop = () => end('cancelled');
      attach();
      fill();
    });
  }

  cancel(): void {
    this.stop?.();
  }

  private discardWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }
}
