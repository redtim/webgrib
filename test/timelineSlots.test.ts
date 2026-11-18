import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  blendedSlots, cycleSlots, deterministicSlots, maxForecastHour, nearestSlotIndex, recentCycles,
  fhourLabel, isSubhourlyOnly, isSubhourlySlot,
} from '../src/demo/timelineSlots.js';
import { forecastQuery, hrrrUrls, rrfsUrls } from '../src/grib2/idx.js';

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

test('isSubhourlyOnly: RRFS cycles off the 3-hourly schedule', () => {
  assert.equal(isSubhourlyOnly('rrfs', '2026111803'), false);
  assert.equal(isSubhourlyOnly('rrfs', '2026111804'), true);
  assert.equal(isSubhourlyOnly('hrrr', '2026111804'), false);
});

test('isSubhourlySlot: quarter hours, and every slot of a sub-hourly-only cycle', () => {
  assert.equal(isSubhourlySlot('hrrr', '2026111804', 3), false);
  assert.equal(isSubhourlySlot('hrrr', '2026111804', 2.25), true);
  assert.equal(isSubhourlySlot('rrfs', '2026111804', 3), true);
  assert.equal(isSubhourlySlot('rrfs', '2026111803', 3), false);
});

test('deterministicSlots: 15-minute step through f018, hourly beyond', () => {
  const slots = deterministicSlots('hrrr', '2026111806', 0.25);
  // 0, 0.25, ... 18 (73 slots) then 19..48 (30 slots).
  assert.equal(slots.length, 73 + 30);
  assert.deepEqual(slots.slice(0, 5).map((s) => s.fhour), [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(slots[72]!.fhour, 18);
  assert.equal(slots[73]!.fhour, 19);
  assert.equal(slots[1]!.validMs - slots[0]!.validMs, HOUR_MS / 4);
});

test('deterministicSlots: a sub-hourly-only RRFS cycle starts at its first step', () => {
  assert.deepEqual(deterministicSlots('rrfs', '2026111804').map((s) => s.fhour), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(deterministicSlots('rrfs', '2026111804', 0.25)[0]!.fhour, 0.25);
  assert.equal(deterministicSlots('rrfs', '2026111804', 0.25).length, 72);
});

test('fhourLabel', () => {
  assert.equal(fhourLabel(3), 't:3');
  assert.equal(fhourLabel(2.25), 't:2:15');
  assert.equal(fhourLabel(0.5), 't:0:30');
});

test('forecastQuery: whole hours accept both spellings, quarter hours use minutes', () => {
  assert.equal(forecastQuery(0).test('anl'), true);
  assert.equal(forecastQuery(3).test('3 hour fcst'), true);
  assert.equal(forecastQuery(3).test('180 min fcst'), true);
  assert.equal(forecastQuery(3).test('30 hour fcst'), false);
  assert.equal(forecastQuery(2.25).test('135 min fcst'), true);
  assert.equal(forecastQuery(2.25).test('2 hour fcst'), false);
});

test('sub-hourly URLs name the file for the hour the step ends in', () => {
  assert.match(hrrrUrls('2026111804', 2.25, 'wrfsubhf').idx, /hrrr\.t04z\.wrfsubhf03\.grib2\.idx$/);
  assert.match(rrfsUrls('2026111804', 2.25, 'subh').idx, /rrfs\.t04z\.2dfld\.3km\.subh\.f003\.conus\.grib2\.idx$/);
  assert.match(rrfsUrls('2026111803', 3).idx, /rrfs\.t03z\.2dfld\.3km\.f003\.conus\.grib2\.idx$/);
});
