/**
 * A day of scans as bars, with a range chosen by dragging or by moving two
 * slider handles from the keyboard.
 */

import { moveEnd, timeOfDay, type Range, type Zone } from './archive.js';
import type { ScanFile } from './s3.js';

const BAR_AREA = 46;
const MINUTE = 60_000;
/** Pointer travel below this is a click, which leaves the selection alone. */
const DRAG_THRESHOLD = 3;

type End = 'from' | 'to';

/** `final` is false while a drag is still moving. */
export type SelectHandler = (range: Range, final: boolean) => void;

/**
 * Horizontal positions shared by bars, handles, ticks and the pointer. Inset by
 * half a bar so that the first and last bars lie wholly inside the track.
 */
export function timelineScale(width: number, scanCount: number, [start, end]: [number, number]) {
  const barWidth = Math.max(1, Math.min(6, width / Math.max(1, scanCount) - 1));
  const span = Math.max(1, width - barWidth);
  return {
    barWidth,
    x: (time: number) => barWidth / 2 + Math.max(0, Math.min(1, (time - start) / (end - start))) * span,
    time: (x: number) => start + ((x - barWidth / 2) / span) * (end - start),
  };
}

export class Timeline {
  private scans: ScanFile[] = [];
  private bounds: [number, number] = [0, 1];
  private zone: Zone = 'local';
  private range: Range | null = null;

  private readonly canvas = document.createElement('canvas');
  private readonly selection = document.createElement('div');
  private readonly ticks = document.createElement('div');
  private readonly handles: Record<End, HTMLDivElement>;

  constructor(private readonly root: HTMLElement, private readonly onSelect: SelectHandler) {
    const track = document.createElement('div');
    track.className = 'track';
    this.selection.className = 'selection';
    this.ticks.className = 'ticks';
    this.handles = { from: this.handle('from', 'Start of range'), to: this.handle('to', 'End of range') };
    track.append(this.canvas, this.selection, this.handles.from, this.handles.to);
    root.replaceChildren(track, this.ticks);
    this.listenForDrags(track);
    new ResizeObserver(() => this.draw()).observe(root);
  }

  setDay(scans: ScanFile[], bounds: [number, number], zone: Zone): void {
    this.scans = scans;
    this.bounds = bounds;
    this.zone = zone;
    this.draw();
  }

  setRange(range: Range | null): void {
    this.range = range;
    this.draw();
  }

  private draw(): void {
    const width = this.root.clientWidth;
    if (width === 0) return;
    const scale = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(width * scale);
    this.canvas.height = Math.round(BAR_AREA * scale);
    const context = this.canvas.getContext('2d')!;
    context.scale(scale, scale);

    // Heights are relative to the day's largest file.
    const largest = this.scans.reduce((max, s) => Math.max(max, s.size), 1);
    const { barWidth, x } = timelineScale(width, this.scans.length, this.bounds);
    for (const scan of this.scans) {
      const height = Math.max(2, (scan.size / largest) * BAR_AREA);
      const chosen = this.range && scan.time >= this.range.from && scan.time <= this.range.to;
      context.fillStyle = chosen ? '#58a6ff' : '#566070';
      context.fillRect(x(scan.time) - barWidth / 2, BAR_AREA - height, barWidth, height);
    }

    const [start, end] = this.bounds;
    const from = x(this.range?.from ?? start);
    const to = x(this.range?.to ?? end);
    this.selection.hidden = !this.range || to < from;
    this.selection.style.left = `${from}px`;
    this.selection.style.width = `${Math.max(0, to - from)}px`;
    for (const which of ['from', 'to'] as const) {
      const handle = this.handles[which];
      const time = this.range?.[which] ?? (which === 'from' ? start : end - 1);
      handle.hidden = this.scans.length === 0;
      handle.style.left = `${x(time)}px`;
      handle.setAttribute('aria-valuemin', String(start));
      handle.setAttribute('aria-valuemax', String(end - 1));
      handle.setAttribute('aria-valuenow', String(time));
      handle.setAttribute('aria-valuetext', timeOfDay(time, this.zone));
    }

    // Hour marks, fewer on narrow screens.
    const every = (width < 500 ? 6 : 3) * 60 * MINUTE;
    const marks: HTMLSpanElement[] = [];
    for (let t = start; end > start + 1 && t < end; t += every) {
      const mark = document.createElement('span');
      mark.textContent = timeOfDay(t, this.zone);
      mark.style.left = `${x(t)}px`;
      marks.push(mark);
    }
    this.ticks.replaceChildren(...marks);
  }

  /** A range snapped to whole minutes, matching what the time fields show. */
  private between(a: number, b: number): Range {
    const [start, end] = this.bounds;
    const minute = (t: number) => Math.floor(Math.max(start, Math.min(end - 1, t)) / MINUTE) * MINUTE;
    return { from: minute(Math.min(a, b)), to: minute(Math.max(a, b)) + MINUTE - 1 };
  }

  private listenForDrags(track: HTMLElement): void {
    let drag: { anchor: number; startX: number; moved: boolean } | null = null;
    const timeAt = (clientX: number) => {
      const box = track.getBoundingClientRect();
      return timelineScale(box.width, this.scans.length, this.bounds).time(clientX - box.left);
    };

    track.addEventListener('pointerdown', (event) => {
      if (this.scans.length === 0 || event.button !== 0) return;
      const [start, end] = this.bounds;
      // Dragging a handle keeps the opposite end still.
      let anchor = timeAt(event.clientX);
      let grabbed = false;
      if (event.target === this.handles.from) [anchor, grabbed] = [this.range?.to ?? end - 1, true];
      if (event.target === this.handles.to) [anchor, grabbed] = [this.range?.from ?? start, true];
      // Preventing the default also prevents focus, which the arrow keys need.
      if (grabbed) (event.target as HTMLElement).focus({ preventScroll: true });
      drag = { anchor, startX: event.clientX, moved: grabbed };
      track.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    track.addEventListener('pointermove', (event) => {
      if (!drag) return;
      drag.moved ||= Math.abs(event.clientX - drag.startX) >= DRAG_THRESHOLD;
      if (drag.moved) this.onSelect(this.between(drag.anchor, timeAt(event.clientX)), false);
    });
    const finish = () => {
      if (drag?.moved && this.range) this.onSelect(this.range, true);
      drag = null;
    };
    track.addEventListener('pointerup', finish);
    track.addEventListener('pointercancel', finish);
  }

  private handle(which: End, label: string): HTMLDivElement {
    const handle = document.createElement('div');
    handle.className = 'handle';
    handle.tabIndex = 0;
    handle.setAttribute('role', 'slider');
    handle.setAttribute('aria-label', label);
    handle.addEventListener('keydown', (event) => {
      const steps: Record<string, number> = {
        ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1,
        PageDown: -10, PageUp: 10, Home: -Infinity, End: Infinity,
      };
      const by = steps[event.key];
      if (by === undefined || this.scans.length === 0) return;
      event.preventDefault();
      const [start, end] = this.bounds;
      const next = moveEnd(this.scans, this.range ?? { from: start, to: end - 1 }, which, by);
      this.onSelect(next, true);
    });
    return handle;
  }
}
