import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blendedSlots, cycleSlots, deterministicSlots, maxForecastHour, nearestSlotIndex, recentCycles,
} from '../src/demo/timelineSlots.js';

const HOUR_MS = 3600000;

test('maxForecastHour: synoptic cycles run long', () => {
  assert.equal(maxForecastHour('hrrr', '2026092906'), 48);
  assert.equal(maxForecastHour('hrrr', '2026092907'), 18);
  assert.equal(maxForecastHour('rrfs', '2026092912'), 84);
  assert.equal(maxForecastHour('rrfs', '2026092913'), 18);
});

test('recentCycles: hourly, newest first, with two synoptic cycles', () => {
  // 2026-09-29 14:30Z, 3 h delay -> newest cycle 11Z.
  const cycles = recentCycles(6, Date.UTC(2026, 8, 29, 14, 30));
  assert.deepEqual(cycles, [
    '2026092911', '2026092910', '2026092909', '2026092908', '2026092907', '2026092906',
    '2026092900',
  ]);
});

test('blendedSlots: newest cycle extended by the newest synoptic cycle', () => {
  const slots = blendedSlots('hrrr', ['2026092909', '2026092908', '2026092906']);
  // 09Z f000-f018, then 06Z f022-f048.
  assert.equal(slots.length, 19 + 27);
  assert.deepEqual(slots[0], { cycle: '2026092909', fhour: 0, validMs: Date.UTC(2026, 8, 29, 9) });
  assert.equal(slots[18]!.cycle, '2026092909');
  assert.equal(slots[18]!.fhour, 18);
  assert.equal(slots[19]!.cycle, '2026092906');
  assert.equal(slots[19]!.fhour, 22);
  assert.equal(slots.at(-1)!.fhour, 48);
  // Hourly with no gaps or repeats.
  for (let i = 1; i < slots.length; i++) {
    assert.equal(slots[i]!.validMs - slots[i - 1]!.validMs, HOUR_MS);
  }
});

test('blendedSlots: a synoptic newest cycle needs no extension', () => {
  const slots = blendedSlots('rrfs', ['2026092912', '2026092911', '2026092906']);
  assert.deepEqual(slots, deterministicSlots('rrfs', '2026092912'));
  assert.equal(slots.length, 85);
});

test('blendedSlots: falls back to an older synoptic cycle', () => {
  // 12Z long range not published yet, so 06Z extends the 13Z run.
  const slots = blendedSlots('hrrr', ['2026092913', '2026092906']);
  assert.equal(slots.at(-1)!.cycle, '2026092906');
  assert.equal(slots.at(-1)!.validMs, Date.UTC(2026, 8, 29, 6) + 48 * HOUR_MS);
});

test('nearestSlotIndex snaps to the closest valid time', () => {
  const slots = cycleSlots('2026092900', [0, 3, 6, 9]);
  const base = Date.UTC(2026, 8, 29, 0);
  assert.equal(nearestSlotIndex(slots, base + 7 * HOUR_MS), 2);
  assert.equal(nearestSlotIndex(slots, base + 100 * HOUR_MS), 3);
  assert.equal(nearestSlotIndex(slots, base - 5 * HOUR_MS), 0);
  assert.equal(nearestSlotIndex([], base), 0);
});
