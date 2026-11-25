/** The archive bar: date, time zone, day timeline, range fields and Load. */

import {
  dateOf, estimateLoad, loadAction, MIN_DATE, scansBetween, shiftDate, timeOfDay, typedDate, typedRange, type Range,
  type Zone,
} from './archive.js';
import type { ScanFile } from './s3.js';
import { Timeline } from './timeline.js';

export interface ArchiveBarState {
  date: string;
  zone: Zone;
  today: string;
  range: Range | null;
  /** The day's scans, and the span the timeline covers. */
  scans: ScanFile[];
  bounds: [number, number];
  /** Replaces the load summary, for listing progress and problems. */
  message: string;
  loading: boolean;
  /** The day could not be listed. */
  failed: boolean;
}

export interface ArchiveBarEvents {
  date(date: string): void;
  zone(zone: Zone): void;
  range(range: Range, final: boolean): void;
  load(): void;
  cancel(): void;
  retry(): void;
}

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function size(bytes: number): string {
  return bytes < 1e9 ? `${Math.max(1, Math.round(bytes / 1e6))} MB` : `${(bytes / 1e9).toFixed(1)} GB`;
}

export class ArchiveBar {
  private readonly dateField = element<HTMLInputElement>('date');
  private readonly previous = element<HTMLButtonElement>('prev-day');
  private readonly next = element<HTMLButtonElement>('next-day');
  private readonly zones = [...document.querySelectorAll<HTMLButtonElement>('[data-zone]')];
  private readonly from = element<HTMLInputElement>('from');
  private readonly to = element<HTMLInputElement>('to');
  private readonly toLabel = element('to-label');
  private readonly summary = element('summary');
  private readonly loadButton = element<HTMLButtonElement>('load');
  private readonly timeline: Timeline;
  private state: ArchiveBarState | null = null;

  constructor(events: ArchiveBarEvents) {
    this.timeline = new Timeline(element('timeline'), (range, final) => events.range(range, final));
    this.dateField.addEventListener('change', () => {
      const date = typedDate(this.dateField.value, this.state!.today);
      if (date && date !== this.state!.date) events.date(date);
    });
    // An unfinished or out-of-range entry gives way to the date being shown.
    this.dateField.addEventListener('blur', () => (this.dateField.value = this.state!.date));
    this.previous.addEventListener('click', () => events.date(shiftDate(this.state!.date, -1)));
    this.next.addEventListener('click', () => events.date(shiftDate(this.state!.date, 1)));
    for (const button of this.zones) {
      button.addEventListener('click', () => events.zone(button.dataset.zone as Zone));
    }
    const typed = () => {
      const range = typedRange({ from: this.from.value, to: this.to.value }, this.state!);
      if (range) events.range(range, true);
    };
    this.from.addEventListener('change', typed);
    this.to.addEventListener('change', typed);
    this.loadButton.addEventListener('click', () => events[this.action()]());
  }

  private action() {
    const { loading, failed, range, scans } = this.state!;
    return loadAction({ loading, failed, count: scansBetween(scans, range).length }).action;
  }

  render(state: ArchiveBarState): void {
    const dayChanged = this.state?.scans !== state.scans || this.state.zone !== state.zone;
    this.state = state;
    const { date, zone, today, range, scans, bounds, message, loading } = state;

    this.dateField.min = MIN_DATE;
    this.dateField.max = today;
    // Rewriting the field would interrupt someone typing in it.
    if (document.activeElement !== this.dateField) this.dateField.value = date;
    this.previous.disabled = date <= MIN_DATE;
    this.next.disabled = date >= today;
    for (const button of this.zones) button.setAttribute('aria-pressed', String(button.dataset.zone === zone));

    if (dayChanged) this.timeline.setDay(scans, bounds, zone);
    this.timeline.setRange(range);
    // Leave a field alone while it is being typed in.
    for (const [field, time] of [[this.from, range?.from], [this.to, range?.to]] as const) {
      if (document.activeElement !== field) field.value = time === undefined ? '' : timeOfDay(time, zone);
    }

    const crossesDays = range !== null && dateOf(range.to, zone) > dateOf(range.from, zone);
    this.toLabel.textContent = crossesDays ? 'To (next day)' : 'To';

    const estimate = estimateLoad(scansBetween(scans, range));
    let text = message;
    if (!text && scans.length > 0) {
      if (!range) text = 'Drag across the timeline to choose a range';
      else if (range.from > range.to) text = 'From is later than To';
      else if (estimate.count === 0) text = 'No scans in this range';
      else {
        text = `${estimate.count} ${estimate.count === 1 ? 'scan' : 'scans'} · about ${size(estimate.downloadBytes)} download · ${size(estimate.memoryBytes)} memory`;
        if (estimate.large) text += ' · Large load: it may be slow or run out of memory';
      }
    }
    this.summary.textContent = text;
    this.summary.classList.toggle('warning', !message && estimate.large);
    const button = loadAction({ loading, failed: state.failed, count: estimate.count });
    this.loadButton.textContent = button.label;
    this.loadButton.disabled = !button.enabled;
  }
}
