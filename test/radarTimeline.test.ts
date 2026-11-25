import { test } from 'node:test';
import assert from 'node:assert/strict';

import { timelineScale } from '../src/radar/timeline.js';

test('puts bars, handles and pointer on one scale that stays inside the track', () => {
  const scale = timelineScale(600, 50, [1000, 5000]);
  assert.equal(scale.x(1000) - scale.barWidth / 2, 0);
  assert.equal(scale.x(5000) + scale.barWidth / 2, 600);
  assert.equal(scale.x(3000), 300);
  assert.ok(Math.abs(scale.time(scale.x(4321)) - 4321) < 1e-6);
});

test('keeps positions within the track for times outside the day', () => {
  const scale = timelineScale(600, 300, [1000, 5000]);
  assert.equal(scale.x(0), scale.x(1000));
  assert.equal(scale.x(9000), scale.x(5000));
});
