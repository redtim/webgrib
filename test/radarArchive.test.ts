// A zone with daylight saving, set before any date is built.
process.env.TZ = 'America/Chicago';

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  atTimeOfDay, dateOf, dayBounds, estimateLoad, formatViewState, FRAME_BYTES, latestOnly, loadAction, MIN_DATE, moveEnd,
  parseViewState, scansBetween, shiftDate, timeOfDay, typedDate, typedRange, utcFolders, type ViewState,
} from '../src/radar/archive.js';
import type { ScanFile } from '../src/radar/s3.js';

const iso = (ms: number) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const scan = (time: number, size = 10e6, ending = '_V06'): ScanFile => ({ key: `k${time}${ending}`, time, size });

test('bounds a local day, which spans two UTC folders', () => {
  const [start, end] = dayBounds('2013-05-20', 'local');
  assert.deepEqual([iso(start), iso(end)], ['2013-05-20T05:00:00.000Z', '2013-05-21T05:00:00.000Z']);
  assert.deepEqual(utcFolders(start, end), ['2013/05/20/', '2013/05/21/']);
});

test('keeps daylight saving days their true length', () => {
  const hours = (date: string) => {
    const [start, end] = dayBounds(date, 'local');
    return (end - start) / HOUR;
  };
  assert.equal(hours('2026-03-08'), 23);
  assert.equal(hours('2026-11-01'), 25);
});

test('needs one folder for a UTC day', () => {
  assert.deepEqual(utcFolders(...dayBounds('2013-05-20', 'utc')), ['2013/05/20/']);
});

test('names the date of an instant in either zone', () => {
  const lateEvening = Date.parse('2013-05-21T03:00:00Z');
  assert.equal(dateOf(lateEvening, 'local'), '2013-05-20');
  assert.equal(dateOf(lateEvening, 'utc'), '2013-05-21');
});

test('shifts dates across month and year ends', () => {
  assert.equal(shiftDate('2024-02-28', 1), '2024-02-29');
  assert.equal(shiftDate('2026-01-01', -1), '2025-12-31');
});

test('converts clock times both ways', () => {
  const at = Date.parse('2013-05-20T19:56:00Z');
  assert.equal(timeOfDay(at, 'local'), '14:56');
  assert.equal(timeOfDay(at, 'utc'), '19:56');
  assert.equal(atTimeOfDay('2013-05-20', '14:56', 'local'), at);
  assert.equal(atTimeOfDay('2013-05-20', '19:56', 'utc'), at);
});

test('selects scans inside a range, inclusive of both ends', () => {
  const scans = [scan(0), scan(10), scan(20), scan(30)];
  assert.deepEqual(scansBetween(scans, { from: 10, to: 20 }).map((s) => s.time), [10, 20]);
});

test('selects nothing for a reversed, empty or missing range', () => {
  const scans = [scan(0), scan(10)];
  assert.deepEqual(scansBetween(scans, { from: 10, to: 0 }), []);
  assert.deepEqual(scansBetween(scans, { from: 2, to: 8 }), []);
  assert.deepEqual(scansBetween(scans, null), []);
  assert.equal(estimateLoad([]).count, 0);
});

test('estimates download from the share of each file that is read, and memory per frame', () => {
  const modern = estimateLoad([scan(0), scan(1)]);
  assert.equal(modern.downloadBytes, 6e6);
  assert.equal(modern.memoryBytes, 2 * FRAME_BYTES);
  assert.equal(modern.large, false);
  assert.equal(estimateLoad([scan(0, 10e6, '_V06.gz')]).downloadBytes, 4.5e6);
});

test('flags a load above 1 GB of memory or download', () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) => scan(i, 1e5));
  assert.equal(estimateLoad(many(450)).large, false);
  assert.equal(estimateLoad(many(460)).large, true);
  assert.equal(estimateLoad([scan(0, 4e9)]).large, true);
});

test('moves an end of a dragged range by one scan on the first press', () => {
  const scans = [scan(0), scan(10), scan(20), scan(30)];
  const dragged = { from: 5, to: 25 }; // holds the scans at 10 and 20
  assert.deepEqual(moveEnd(scans, dragged, 'from', -1), { from: 0, to: 25 });
  assert.deepEqual(moveEnd(scans, dragged, 'from', 1), { from: 20, to: 25 });
  assert.deepEqual(moveEnd(scans, dragged, 'to', 1), { from: 5, to: 30 });
  assert.deepEqual(moveEnd(scans, dragged, 'to', -1), { from: 5, to: 10 });
});

test('never moves one end past the other, and jumps to the ends of the day', () => {
  const scans = [scan(0), scan(10), scan(20), scan(30)];
  assert.deepEqual(moveEnd(scans, { from: 10, to: 10 }, 'from', 1), { from: 10, to: 10 });
  assert.deepEqual(moveEnd(scans, { from: 10, to: 10 }, 'to', -1), { from: 10, to: 10 });
  assert.deepEqual(moveEnd(scans, { from: 10, to: 20 }, 'from', -Infinity), { from: 0, to: 20 });
  assert.deepEqual(moveEnd(scans, { from: 10, to: 20 }, 'to', Infinity), { from: 10, to: 30 });
  assert.deepEqual(moveEnd([], { from: 1, to: 2 }, 'to', 1), { from: 1, to: 2 });
});

const utc = (text: string) => Date.parse(`${text}Z`);

test('reads the time fields as a range within the day', () => {
  const day = { date: '2013-05-20', zone: 'utc' as const, range: null, bounds: dayBounds('2013-05-20', 'utc') };
  assert.deepEqual(typedRange({ from: '14:00', to: '15:30' }, day), {
    from: utc('2013-05-20T14:00:00'), to: utc('2013-05-20T15:30:59.999'),
  });
  assert.equal(typedRange({ from: '14:00', to: '' }, day)!.to, day.bounds[1] - 1);
  assert.equal(typedRange({ from: '', to: '15:30' }, day)!.from, day.bounds[0]);
  assert.equal(typedRange({ from: '', to: '' }, day), null);
  const backwards = typedRange({ from: '15:00', to: '14:00' }, day)!;
  assert.ok(backwards.from > backwards.to);
});

test('reads the time fields across two local days', () => {
  // A whole UTC day seen from Chicago: 19:00 on the 19th to 18:59 on the 20th.
  const range = { from: utc('2013-05-20T00:00:00'), to: utc('2013-05-20T23:59:59.999') };
  const view = {
    date: '2013-05-19', zone: 'local' as const, range,
    bounds: [dayBounds('2013-05-19', 'local')[0], range.to + 1] as [number, number],
  };
  assert.deepEqual(typedRange({ from: '19:00', to: '18:59' }, view), range);
  // Moving the start earlier keeps the end on the second day.
  assert.deepEqual(typedRange({ from: '10:00', to: '18:59' }, view), { from: utc('2013-05-19T15:00:00'), to: range.to });
  // An end that only fits the first day goes there.
  assert.equal(typedRange({ from: '19:00', to: '22:00' }, view)!.to, utc('2013-05-20T03:00:59.999'));
});

test('offers Load, Cancel or Retry as the day allows', () => {
  assert.deepEqual(loadAction({ loading: true, failed: false, count: 3 }), { action: 'cancel', label: 'Cancel', enabled: true });
  assert.deepEqual(loadAction({ loading: false, failed: true, count: 0 }), { action: 'retry', label: 'Retry', enabled: true });
  assert.deepEqual(loadAction({ loading: false, failed: false, count: 0 }), { action: 'load', label: 'Load', enabled: false });
  assert.deepEqual(loadAction({ loading: false, failed: false, count: 3 }), { action: 'load', label: 'Load', enabled: true });
});

const now = new Date('2026-11-25T18:00:00Z');

test('round-trips an archive bookmark', () => {
  const state: ViewState = {
    mode: 'archive', site: 'KTLX', product: 'VEL', date: '2013-05-20', zone: 'utc',
    range: { from: Date.parse('2013-05-20T19:00:00Z'), to: Date.parse('2013-05-20T21:30:59.999Z') },
  };
  assert.deepEqual(parseViewState(formatViewState(state), now), state);
});

test('keeps the live address as it was', () => {
  const live = parseViewState('?site=KMHX&product=VEL', now);
  assert.equal(live.mode, 'live');
  assert.equal(formatViewState(live), '?site=KMHX&product=VEL');
});

test('falls back to defaults for a damaged bookmark', () => {
  assert.deepEqual(parseViewState('?mode=zzz&date=2013-13-45&from=abc&site=../x', now), {
    mode: 'live', site: 'KMUX', product: 'REF', date: '2026-11-25', zone: 'local', range: null,
  });
});

test('keeps dates between the earliest supported one and today', () => {
  assert.equal(parseViewState('?mode=archive&date=1999-05-03', now).date, MIN_DATE);
  assert.equal(parseViewState('?mode=archive&date=2030-01-01', now).date, '2026-11-25');
});

test('drops a bookmarked range that runs backwards', () => {
  const search = '?mode=archive&date=2013-05-20&from=2013-05-20T21:00:00Z&to=2013-05-20T19:00:00Z';
  assert.equal(parseViewState(search, now).range, null);
});

test('shows the day the bookmarked range starts on in this viewer’s zone', () => {
  // Shared by someone further east: 02:00Z on the 21st is the evening of the 20th here.
  const search = '?mode=archive&date=2013-05-21&from=2013-05-21T02:00:00Z&to=2013-05-21T03:00:00Z';
  assert.equal(parseViewState(search, now).date, '2013-05-20');
});

test('lets only the latest request apply its result', () => {
  const next = latestOnly();
  const first = next();
  assert.ok(first());
  const second = next();
  assert.ok(!first(), 'an earlier request is superseded');
  assert.ok(second());
});

test('drops a bookmarked range that no single day could hold', () => {
  const ranges = [
    ['1995-05-20T19:00:00Z', '1995-05-20T21:00:00Z'], // before the earliest date
    ['2013-05-20T19:00:00Z', '2023-05-20T21:00:00Z'], // ten years long
    ['2031-05-20T19:00:00Z', '2031-05-20T21:00:00Z'], // in the future
    ['1', '2'], // read by Date.parse as early 2001
    ['0001-01-01T00:00:00Z', '0001-01-01T01:00:00Z'],
  ];
  for (const [from, to] of ranges) {
    const state = parseViewState(`?mode=archive&date=2013-05-20&from=${from}&to=${to}`, now);
    assert.equal(state.range, null, from);
    assert.equal(state.date, '2013-05-20', from);
  }
});

test('keeps a range for the whole of today, though it ends after now', () => {
  const search = '?mode=archive&tz=utc&from=2026-11-25T00:00:00Z&to=2026-11-25T23:59:59.999Z';
  assert.ok(parseViewState(search, now).range);
});

test('accepts a typed date only once it is one that can be shown', () => {
  // What Chromium reports while the year 2011 is typed digit by digit.
  for (const partial of ['0002-05-20', '0020-05-20', '0201-05-20', '', '2031-05-20']) {
    assert.equal(typedDate(partial, '2026-11-25'), null, partial);
  }
  assert.equal(typedDate('2011-05-20', '2026-11-25'), '2011-05-20');
  assert.equal(typedDate('2026-11-25', '2026-11-25'), '2026-11-25');
});
