import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spaced } from '../src/radar/throttle.js';

test('writes at once when idle, then no more often than the interval', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 10_000 });
  const written: number[] = [];
  let value = 0;
  const write = spaced(() => written.push(value), 400);
  for (value = 1; value <= 100; value++) {
    write();
    t.mock.timers.tick(30); // a held arrow key
  }
  value = 100;
  t.mock.timers.tick(400);
  assert.equal(written[0], 1, 'the first change is written immediately');
  assert.equal(written.at(-1), 100, 'the last change is not lost');
  assert.ok(written.length <= 10, `${written.length} writes in 3 s`);
});
