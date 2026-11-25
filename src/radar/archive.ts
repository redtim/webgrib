/** Rules for browsing past radar: days, ranges, load estimates and bookmarks. */

import type { ProductId } from './colors.js';
import type { ScanFile } from './s3.js';

export type Zone = 'local' | 'utc';

/** Inclusive, ms since the epoch. */
export interface Range {
  from: number;
  to: number;
}

export interface ViewState {
  mode: 'live' | 'archive';
  site: string;
  product: ProductId;
  /** `YYYY-MM-DD` in `zone`. */
  date: string;
  zone: Zone;
  range: Range | null;
}

/** Files from before late 2008 use an older format; some 2008 dates still do. */
export const MIN_DATE = '2008-01-01';
/** Loads above this, in download or memory, draw a warning. */
export const WARN_BYTES = 1e9;
/** One loaded scan: super-resolution reflectivity and velocity, a byte per gate. */
export const FRAME_BYTES = 720 * (1832 + 1192);

// Share of a listed file read before the low tilts are complete.
const READ_SHARE = 0.3;
const GZIP_READ_SHARE = 0.45;

const DEFAULT_SITE = 'KMUX';
const DAY_MS = 86_400_000;
// A day, plus the spill past it that a bookmark shared across zones can have.
const LONGEST_RANGE_MS = 2 * DAY_MS;

const pad = (n: number) => String(n).padStart(2, '0');

function partsOf(ms: number, zone: Zone) {
  const d = new Date(ms);
  return zone === 'utc'
    ? { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() }
    : { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes() };
}

function instant(zone: Zone, year: number, month: number, day: number, hour = 0, minute = 0): number {
  return zone === 'utc'
    ? Date.UTC(year, month - 1, day, hour, minute)
    : new Date(year, month - 1, day, hour, minute).getTime();
}

export function dateOf(ms: number, zone: Zone): string {
  const { year, month, day } = partsOf(ms, zone);
  return `${year}-${pad(month)}-${pad(day)}`;
}

export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** Start of the day and start of the next, so 23 or 25 hours at a clock change. */
export function dayBounds(date: string, zone: Zone): [start: number, end: number] {
  const startOf = (d: string) => {
    const [year, month, day] = d.split('-').map(Number);
    return instant(zone, year!, month!, day!);
  };
  return [startOf(date), startOf(shiftDate(date, 1))];
}

/** Bucket date folders covering [start, end). */
export function utcFolders(start: number, end: number): string[] {
  const folders: string[] = [];
  for (let day = Math.floor(start / DAY_MS); day * DAY_MS < end; day++) {
    folders.push(`${new Date(day * DAY_MS).toISOString().slice(0, 10).replaceAll('-', '/')}/`);
  }
  return folders;
}

export function timeOfDay(ms: number, zone: Zone): string {
  const { hour, minute } = partsOf(ms, zone);
  return `${pad(hour)}:${pad(minute)}`;
}

export function atTimeOfDay(date: string, time: string, zone: Zone): number {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  return instant(zone, year!, month!, day!, hour, minute);
}

export function scansBetween(scans: ScanFile[], range: Range | null): ScanFile[] {
  if (!range) return [];
  return scans.filter((s) => s.time >= range.from && s.time <= range.to);
}

export function estimateLoad(scans: ScanFile[]) {
  const downloadBytes = Math.round(
    scans.reduce((sum, s) => sum + s.size * (s.key.endsWith('.gz') ? GZIP_READ_SHARE : READ_SHARE), 0),
  );
  const memoryBytes = scans.length * FRAME_BYTES;
  return { count: scans.length, downloadBytes, memoryBytes, large: Math.max(downloadBytes, memoryBytes) > WARN_BYTES };
}

/**
 * Move one end of a range `by` scans, counting from the outermost scan it holds,
 * so that every press changes the selection. The ends never pass each other.
 */
export function moveEnd(scans: ScanFile[], range: Range, end: 'from' | 'to', by: number): Range {
  if (scans.length === 0) return range;
  const after = scans.findIndex((s) => s.time >= range.from);
  const upTo = scans.filter((s) => s.time <= range.to).length - 1;
  const held = end === 'from' ? (after < 0 ? scans.length - 1 : after) : Math.max(0, upTo);
  const { time } = scans[Math.max(0, Math.min(scans.length - 1, held + by))]!;
  return end === 'from'
    ? { from: Math.min(time, range.to), to: range.to }
    : { from: range.from, to: Math.max(time, range.from) };
}

/**
 * The range meant by the From and To fields, which hold only clock times. The
 * timeline can cover two days, so each time stays on its current end's day where
 * that fits. An empty field stands for that end of the timeline.
 */
export function typedRange(
  fields: { from: string; to: string },
  view: { date: string; zone: Zone; range: Range | null; bounds: [number, number] },
): Range | null {
  const { date, zone, range, bounds: [start, end] } = view;
  if (!fields.from && !fields.to) return null;
  const within = (t: number) => t >= start && t < end;
  const firstDay = range ? dateOf(range.from, zone) : date;

  let from = start;
  if (fields.from) {
    const choices = [firstDay, date, shiftDate(date, 1)].map((d) => atTimeOfDay(d, fields.from, zone));
    from = choices.find(within) ?? atTimeOfDay(date, fields.from, zone);
  }
  let to = end - 1;
  if (fields.to) {
    const fromDay = dateOf(from, zone);
    const days = [range ? dateOf(range.to, zone) : fromDay, fromDay, shiftDate(fromDay, 1)];
    // "To" includes the whole of the minute typed.
    const choices = days.map((d) => atTimeOfDay(d, fields.to, zone) + 59_999);
    // With no later occurrence on the timeline, the range is left running backwards.
    to = choices.find((t) => within(t) && t >= from) ?? atTimeOfDay(fromDay, fields.to, zone) + 59_999;
  }
  return { from, to };
}

/** What the archive's one button does, given the state of the day. */
export function loadAction({ loading, failed, count }: { loading: boolean; failed: boolean; count: number }) {
  if (loading) return { action: 'cancel', label: 'Cancel', enabled: true } as const;
  if (failed) return { action: 'retry', label: 'Retry', enabled: true } as const;
  return { action: 'load', label: 'Load', enabled: count > 0 } as const;
}

function validDate(text: string | null): text is string {
  if (!text || !/^\d{4}-\d\d-\d\d$/.test(text)) return false;
  const ms = Date.parse(`${text}T00:00:00Z`);
  return !Number.isNaN(ms) && new Date(ms).toISOString().startsWith(text);
}

/** A date field's value if it names a day that can be shown, else null. */
export function typedDate(text: string, today: string): string | null {
  // While a year is being typed the field reports years like 0002 and 0201.
  return validDate(text) && text >= MIN_DATE && text <= today ? text : null;
}

/** Read the address bar, replacing anything missing or malformed with a default. */
export function parseViewState(search: string, now: Date): ViewState {
  const params = new URLSearchParams(search);
  const site = params.get('site')?.toUpperCase() ?? '';
  const zone: Zone = params.get('tz') === 'utc' ? 'utc' : 'local';
  const today = dateOf(now.getTime(), zone);

  const from = Date.parse(params.get('from') ?? '');
  const to = Date.parse(params.get('to') ?? '');
  // Listing covers every day of a range, so an implausible one must not get in.
  const plausible = from <= to && to - from <= LONGEST_RANGE_MS
    && from >= dayBounds(MIN_DATE, zone)[0] && from <= now.getTime();
  const range = plausible ? { from, to } : null;

  // A range decides the day, which may differ for whoever shared the address.
  const asked = range ? dateOf(range.from, zone) : params.get('date');
  let date = validDate(asked) ? asked : today;
  if (date < MIN_DATE) date = MIN_DATE;
  if (date > today) date = today;

  return {
    mode: params.get('mode') === 'archive' ? 'archive' : 'live',
    site: /^[A-Z0-9]{4}$/.test(site) ? site : DEFAULT_SITE,
    product: params.get('product') === 'VEL' ? 'VEL' : 'REF',
    date,
    zone,
    range,
  };
}

export function formatViewState({ mode, site, product, date, zone, range }: ViewState): string {
  if (mode === 'live') return `?site=${site}&product=${product}`;
  const params = new URLSearchParams({ mode, site, product, date, tz: zone });
  if (range) {
    params.set('from', new Date(range.from).toISOString());
    params.set('to', new Date(range.to).toISOString());
  }
  return `?${params}`;
}

/** For overlapping requests: each call returns a check that fails once a newer call is made. */
export function latestOnly(): () => () => boolean {
  let newest = 0;
  return () => {
    const mine = ++newest;
    return () => mine === newest;
  };
}
