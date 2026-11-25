import { test } from 'node:test';
import assert from 'node:assert/strict';

import { FrameLoop, frameDelay } from '../src/radar/loop.js';

/** Frames are identified by their S3 key, which sorts by scan time. */
function loopOf(...keys: string[]) {
  const loop = new FrameLoop<{ key: string }>();
  loop.setWindow(keys);
  for (const key of keys) loop.add({ key });
  return loop;
}

const keys = (loop: FrameLoop<{ key: string }>) => loop.frames.map((f) => f.key);

test('asks for the missing scans, newest first', () => {
  const loop = loopOf('a', 'b');
  assert.deepEqual(loop.setWindow(['a', 'b', 'c', 'd']), ['d', 'c']);
});

test('keeps frames in time order however they arrive', () => {
  const loop = new FrameLoop<{ key: string }>();
  loop.setWindow(['a', 'b', 'c']);
  for (const key of ['c', 'a', 'b']) loop.add({ key });
  assert.deepEqual(keys(loop), ['a', 'b', 'c']);
});

test('stays on the newest scan while older ones load behind it', () => {
  const loop = new FrameLoop<{ key: string }>();
  loop.setWindow(['a', 'b', 'c']);
  loop.add({ key: 'c' });
  loop.add({ key: 'b' });
  assert.equal(loop.current!.key, 'c');
});

test('moves on to a newer scan when showing the newest', () => {
  const loop = loopOf('a', 'b');
  loop.setWindow(['a', 'b', 'c']);
  loop.add({ key: 'c' });
  assert.equal(loop.current!.key, 'c');
});

test('holds an older scan in view as the window slides', () => {
  const loop = loopOf('a', 'b', 'c');
  loop.seek(1);
  loop.setWindow(['b', 'c', 'd']);
  loop.add({ key: 'd' });
  assert.deepEqual(keys(loop), ['b', 'c', 'd']);
  assert.equal(loop.current!.key, 'b');
});

test('falls back to the oldest scan when the one in view expires', () => {
  const loop = loopOf('a', 'b', 'c');
  loop.seek(0);
  loop.setWindow(['b', 'c']);
  assert.equal(loop.current!.key, 'b');
});

test('ignores a frame that is no longer wanted, or already held', () => {
  const loop = loopOf('b', 'c');
  loop.add({ key: 'a' });
  loop.add({ key: 'c' });
  assert.deepEqual(keys(loop), ['b', 'c']);
});

test('steps forwards and backwards, wrapping at both ends', () => {
  const loop = loopOf('a', 'b', 'c');
  loop.step(1);
  assert.equal(loop.current!.key, 'a');
  loop.step(-1);
  assert.equal(loop.current!.key, 'c');
});

test('is empty until a frame arrives', () => {
  const loop = new FrameLoop<{ key: string }>();
  loop.step(1);
  loop.seek(3);
  assert.equal(loop.current, undefined);
  assert.equal(loop.index, 0);
});

test('dwells on the newest frame', () => {
  assert.ok(frameDelay(9, 10) > frameDelay(8, 10) * 2);
  assert.equal(frameDelay(0, 10), frameDelay(8, 10));
});

test('can hold its place while later frames arrive', () => {
  const loop = new FrameLoop<{ key: string }>({ followNewest: false });
  loop.setWindow(['a', 'b', 'c']);
  for (const key of ['a', 'b', 'c']) loop.add({ key });
  assert.equal(loop.current!.key, 'a');
});

test('a loop that holds its place rests on the oldest frame until the viewer moves', () => {
  const loop = new FrameLoop<{ key: string }>({ followNewest: false });
  loop.setWindow(['a', 'b', 'c']);
  loop.add({ key: 'b' });
  loop.add({ key: 'a' });
  assert.equal(loop.current!.key, 'a');
  loop.step(1);
  loop.add({ key: 'c' });
  assert.equal(loop.current!.key, 'b');
});

test('starts a new window at its oldest frame, even after the viewer moved in the last one', () => {
  const loop = new FrameLoop<{ key: string }>({ followNewest: false });
  loop.setWindow(['a1', 'a2']);
  for (const key of ['a1', 'a2']) loop.add({ key });
  loop.step(1);
  loop.setWindow(['b1', 'b2', 'b3']);
  for (const key of ['b2', 'b1', 'b3']) loop.add({ key });
  assert.equal(loop.current!.key, 'b1');
});
