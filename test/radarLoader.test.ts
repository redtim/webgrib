import { test } from 'node:test';
import assert from 'node:assert/strict';

import { OLDER_FORMAT_MESSAGE } from '../src/radar/level2.js';
import { outcomeMessage, ScanLoader, type WorkerLike } from '../src/radar/loader.js';
import type { Scan, WorkerReply } from '../src/radar/worker.js';

/** Stands in for the decode worker; the test decides when each key answers. */
class FakeWorker implements WorkerLike {
  sent: string[] = [];
  terminated = false;
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  private answered = 0;

  postMessage({ key }: { key: string }) {
    this.sent.push(key);
  }
  terminate() {
    this.terminated = true;
  }
  get inFlight() {
    return this.sent.length - this.answered;
  }
  reply(data: WorkerReply) {
    this.answered++;
    this.onmessage?.({ data } as MessageEvent<WorkerReply>);
  }
  succeed(key: string) {
    this.reply({ scan: { key } as Scan });
  }
  fail(key: string, error: string, outOfMemory = false) {
    this.reply({ key, error, outOfMemory });
  }
}

function setup() {
  const workers: FakeWorker[] = [];
  const loader = new ScanLoader(() => {
    const worker = new FakeWorker();
    workers.push(worker);
    return worker;
  });
  const loaded: string[] = [];
  const failed: string[] = [];
  const load = (keys: string[]) =>
    loader.load(keys, { scan: (s) => loaded.push(s.key), failed: (key) => failed.push(key) });
  return { loader, workers, loaded, failed, load };
}

const keys = ['a', 'b', 'c', 'd', 'e'];

test('loads every scan with no more than three in flight', async () => {
  const { workers, loaded, load } = setup();
  const result = load(keys);
  const worker = workers[0]!;
  assert.deepEqual(worker.sent, ['a', 'b', 'c']);
  for (const key of keys) {
    worker.succeed(key);
    assert.ok(worker.inFlight <= 3);
  }
  assert.equal(await result, 'done');
  assert.deepEqual(loaded, keys);
});

test('is done at once when there is nothing to load', async () => {
  assert.equal(await setup().load([]), 'done');
});

test('reports a failed scan and carries on', async () => {
  const { workers, loaded, failed, load } = setup();
  const result = load(['a', 'b']);
  workers[0]!.fail('a', 'HTTP 500');
  workers[0]!.succeed('b');
  assert.equal(await result, 'done');
  assert.deepEqual([loaded, failed], [['b'], ['a']]);
});

for (const [outcome, error, outOfMemory] of [
  ['out-of-memory', 'Array buffer allocation failed', true],
  ['older-format', OLDER_FORMAT_MESSAGE, false],
] as const) {
  test(`stops the whole load on ${outcome}`, async () => {
    const { workers, load } = setup();
    const result = load(keys);
    workers[0]!.fail('a', error, outOfMemory);
    assert.equal(await result, outcome);
    assert.deepEqual(workers[0]!.sent, ['a', 'b', 'c']);
    assert.ok(workers[0]!.terminated);
  });
}

test('cancels, keeping nothing that arrives late', async () => {
  const { loader, workers, loaded, load } = setup();
  const result = load(keys);
  workers[0]!.succeed('a');
  loader.cancel();
  workers[0]!.succeed('b');
  assert.equal(await result, 'cancelled');
  assert.ok(workers[0]!.terminated);
  assert.deepEqual(loaded, ['a']);
});

test('cancels the previous load when a new one starts', async () => {
  const { workers, loaded, load } = setup();
  const first = load(['a']);
  const second = load(['z']);
  workers[0]!.succeed('a');
  workers[1]!.succeed('z');
  assert.equal(await first, 'cancelled');
  assert.equal(await second, 'done');
  assert.deepEqual(loaded, ['z']);
});

test('replaces a crashed worker and finishes the rest', async () => {
  const { workers, loaded, failed, load } = setup();
  const result = load(keys);
  workers[0]!.onerror?.({ message: 'boom' } as ErrorEvent);
  assert.deepEqual(failed, ['a', 'b', 'c']);
  workers[1]!.succeed('d');
  workers[1]!.succeed('e');
  assert.equal(await result, 'done');
  assert.deepEqual(loaded, ['d', 'e']);
});

test('words how a load ended', () => {
  assert.equal(outcomeMessage('done', 5, 5, 0), '');
  assert.equal(outcomeMessage('done', 4, 5, 1), '1 scan could not be loaded and was skipped');
  assert.equal(outcomeMessage('done', 3, 5, 2), '2 scans could not be loaded and were skipped');
  assert.equal(outcomeMessage('out-of-memory', 3, 10, 0), 'Stopped at 3 of 10 scans: out of memory');
  assert.equal(outcomeMessage('older-format', 0, 10, 0), OLDER_FORMAT_MESSAGE);
  assert.equal(outcomeMessage('cancelled', 2, 9, 0), 'Loading cancelled at 2 of 9 scans');
});
