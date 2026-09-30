/**
 * Forecast timeline control. Shows a cycle selector and a horizontal bar of
 * forecast-hour ticks grouped by day with labels and dividers, plus play and
 * "Now" buttons. Easy mode hides the model/cycle selectors via CSS.
 *
 * Each tick is a slot: a forecast hour of a specific cycle. The default
 * "Latest" run blends cycles so the bar covers every hour on offer, rather
 * than stopping at the 18 h that most hourly cycles run to.
 */

import {
  blendedSlots, cycleSlots, deterministicSlots, maxForecastHour, nearestSlotIndex, recentCycles,
  formatCycle,
} from './timelineSlots.js';
import type { DeterministicModel, TimelineSlot } from './timelineSlots.js';

export type { DeterministicModel, TimelineSlot };

export interface TimelineOptions {
  parent: HTMLElement;
  /** May return a promise for the resulting load; playback waits on it. */
  onChange: (cycle: string, fhour: number) => void | Promise<void>;
  /**
   * Optional availability check for a forecast hour of a deterministic model
   * cycle. Each listed cycle is probed at its last hour, so only fully
   * published cycles are used; the rest are disabled in the dropdown.
   */
  probeCycle?: (model: DeterministicModel, cycle: string, fhour: number) => Promise<boolean>;
}

export type TimelineSource = DeterministicModel | 'gefs';

const MODEL_LABELS: Record<DeterministicModel, string> = { hrrr: 'HRRR', rrfs: 'RRFS' };
const MODEL_HINTS: Record<DeterministicModel, string> = {
  hrrr: 'High-Resolution Rapid Refresh: 3 km, up to 48 hours',
  rrfs: 'Rapid Refresh Forecast System: 3 km, up to 84 hours',
};

/** Pause on each frame during playback, after its data has loaded. */
const PLAY_DWELL_MS = 800;

/** Dropdown value for the blended run. */
const LATEST = 'latest';

export class Timeline {
  private cycleSelect: HTMLSelectElement;
  private modelSelect: HTMLSelectElement;
  /** Easy-mode stand-in for modelSelect: one chip per model. */
  private modelChips = new Map<DeterministicModel, HTMLButtonElement>();
  private dayRow: HTMLElement;
  private tickContainer: HTMLElement;
  private validLabel: HTMLElement;
  private playBtn: HTMLButtonElement;
  private playing = false;
  private pending: Promise<void> = Promise.resolve();
  /** Selected run: a cycle, or LATEST for the blend of available cycles. */
  private _run = LATEST;
  /** Cycles on offer, newest first. */
  private _cycles: string[] = [];
  /** Cycles confirmed published, or null until the probe reports. */
  private _available: Set<string> | null = null;
  private _slots: TimelineSlot[] = [];
  private _index = 0;
  private _source: TimelineSource = 'hrrr';
  private _model: DeterministicModel = 'hrrr';
  private _gefsFhours: number[] | null = null;
  private onChange: TimelineOptions['onChange'];
  private probeCycle: TimelineOptions['probeCycle'];
  private probeGen = 0;

  get cycle(): string { return this._slots[this._index]?.cycle ?? ''; }
  get fhour(): number { return this._slots[this._index]?.fhour ?? 0; }
  /** The deterministic model in use (kept while GEFS is showing). */
  get model(): DeterministicModel { return this._model; }

  constructor(opts: TimelineOptions) {
    this.onChange = opts.onChange;
    this.probeCycle = opts.probeCycle;

    const wrapper = document.createElement('div');
    wrapper.className = 'timeline';

    // Cycle row
    const cycleRow = document.createElement('div');
    cycleRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;justify-content:center;';
    const cycleLabel = document.createElement('span');
    cycleLabel.textContent = 'Model Run';
    cycleLabel.className = 'timeline-run';
    cycleLabel.style.cssText = 'color:#8b949e;font-size:11px;';
    this.modelSelect = document.createElement('select');
    this.modelSelect.className = 'timeline-run';
    this.modelSelect.style.cssText = 'width:auto;';
    this.modelSelect.title = 'Deterministic model';
    for (const m of Object.keys(MODEL_LABELS) as DeterministicModel[]) {
      const opt = document.createElement('option');
      opt.value = m;
      opt.textContent = MODEL_LABELS[m];
      this.modelSelect.appendChild(opt);
    }
    this.modelSelect.addEventListener('change', () => {
      this.setModel(this.modelSelect.value as DeterministicModel);
    });
    this.cycleSelect = document.createElement('select');
    this.cycleSelect.className = 'timeline-run';
    this.cycleSelect.style.cssText = 'width:auto;';
    this.validLabel = document.createElement('span');
    this.validLabel.className = 'timeline-valid';
    this.validLabel.style.cssText = 'color:#7ee787;font-size:11px;';

    this.playBtn = document.createElement('button');
    this.playBtn.className = 'timeline-btn timeline-play';
    this.playBtn.addEventListener('click', () => this.setPlaying(!this.playing));
    this.updatePlayBtn();
    const nowBtn = document.createElement('button');
    nowBtn.className = 'timeline-btn';
    nowBtn.textContent = 'Now';
    nowBtn.title = 'Jump to the current time';
    nowBtn.addEventListener('click', () => this.selectNow());

    const chips = document.createElement('div');
    chips.className = 'timeline-models';
    for (const m of Object.keys(MODEL_LABELS) as DeterministicModel[]) {
      const chip = document.createElement('button');
      chip.className = 'timeline-model';
      chip.textContent = MODEL_LABELS[m];
      chip.title = MODEL_HINTS[m];
      chip.addEventListener('click', () => this.setModel(m));
      chips.appendChild(chip);
      this.modelChips.set(m, chip);
    }
    this.updateModelChips();

    cycleRow.append(this.playBtn, cycleLabel, this.modelSelect, this.cycleSelect, this.validLabel, nowBtn, chips);

    // Scrollable container for day labels + ticks (scroll together)
    const scrollWrap = document.createElement('div');
    scrollWrap.className = 'timeline-scroll';
    const inner = document.createElement('div');
    inner.className = 'timeline-inner';

    // Day labels row
    this.dayRow = document.createElement('div');
    this.dayRow.className = 'timeline-day-row';

    // Tick bar
    this.tickContainer = document.createElement('div');
    this.tickContainer.className = 'timeline-ticks';
    this.tickContainer.style.cssText = 'display:flex;gap:1px;padding:2px 0;';

    inner.append(this.dayRow, this.tickContainer);
    scrollWrap.appendChild(inner);
    wrapper.append(cycleRow, scrollWrap);
    opts.parent.appendChild(wrapper);

    this.populateCycles();
    this.cycleSelect.addEventListener('change', () => {
      this._run = this.cycleSelect.value;
      this.rebuild(this.validDate().getTime());
    });

    this.rebuildSlots();
    this.selectIndex(0);
    this.probeCycles();
  }

  /**
   * Switch the timeline between deterministic (HRRR/RRFS) and GEFS modes,
   * keeping the valid time where the new source reaches it. Passing a
   * deterministic source also makes it the current model.
   */
  setSource(source: TimelineSource, gefsFhours?: number[]): void {
    if (source === this._source) return;
    const prevValidMs = this.validDate().getTime();
    this._source = source;
    this._gefsFhours = source === 'gefs' && gefsFhours ? gefsFhours : null;
    if (source !== 'gefs') {
      this._model = source;
      this.modelSelect.value = source;
    }
    this.modelSelect.disabled = source === 'gefs';
    this.updateModelChips();

    this.populateCycles();
    this.rebuild(prevValidMs, true);
    this.probeCycles();
  }

  /**
   * Switch deterministic model, keeping the same valid time where the new
   * model's cycles cover it. No-op while GEFS is showing except to remember
   * the choice for when the timeline returns to deterministic mode.
   */
  setModel(model: DeterministicModel): void {
    this.modelSelect.value = model;
    if (model === this._model) return;
    this._model = model;
    this.updateModelChips();
    if (this._source === 'gefs') return;
    const prevValidMs = this.validDate().getTime();
    this._source = model;
    this.populateCycles();
    this.rebuild(prevValidMs, true);
    this.probeCycles();
  }

  get source(): TimelineSource { return this._source; }

  /** Identifies the set of slots on offer; changes whenever they do. */
  get slotsKey(): string {
    const first = this._slots[0];
    const last = this._slots[this._slots.length - 1];
    return `${this._source}:${first?.cycle}:${last?.cycle}:${this._slots.length}`;
  }

  private updateModelChips(): void {
    for (const [m, chip] of this.modelChips) {
      chip.classList.toggle('active', m === this._model);
      chip.disabled = this._source === 'gefs';
    }
  }

  private populateCycles(): void {
    this._cycles = this._source === 'gefs'
      ? gefsRecentCyclesLocal(4)
      // The RRFS parallel feed occasionally skips cycles, so offer a few more.
      : recentCycles(this._source === 'rrfs' ? 8 : 6, Date.now());
    this._available = null;
    this.cycleSelect.innerHTML = '';
    if (this._source !== 'gefs') {
      const opt = document.createElement('option');
      opt.value = LATEST;
      opt.textContent = 'Latest';
      opt.title = 'Newest data for every hour, blending runs to reach the full forecast range';
      this.cycleSelect.appendChild(opt);
    }
    for (const c of this._cycles) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)} ${c.slice(8, 10)}Z`;
      this.cycleSelect.appendChild(opt);
    }
    this._run = this._source === 'gefs' ? this._cycles[0] ?? '' : LATEST;
    this.cycleSelect.value = this._run;
  }

  /**
   * Check which listed cycles are fully published, disabling the rest. The
   * blended run is rebuilt from the confirmed cycles, and a selected cycle
   * that is missing gives way to it.
   */
  private probeCycles(): void {
    if (!this.probeCycle || this._source === 'gefs') return;
    const gen = ++this.probeGen;
    const model = this._source;
    const cycles = this._cycles;
    void Promise.all(cycles.map((c) => this.probeCycle!(model, c, maxForecastHour(model, c)).catch(() => false)))
      .then((results) => {
        if (gen !== this.probeGen) return;
        const available = new Set(cycles.filter((_, i) => results[i]));
        // Nothing reachable says more about the network than the cycles.
        if (available.size === 0) return;
        this._available = available;
        for (const o of this.cycleSelect.options) {
          if (o.value === LATEST || available.has(o.value)) continue;
          o.disabled = true;
          o.textContent += ' (unavailable)';
        }
        if (this._run !== LATEST && !available.has(this._run)) {
          this._run = LATEST;
          this.cycleSelect.value = LATEST;
        }
        this.rebuild(this.validDate().getTime());
      });
  }

  private rebuildSlots(): void {
    if (this._source === 'gefs') {
      this._slots = cycleSlots(this._run, this._gefsFhours ?? []);
    } else if (this._run === LATEST) {
      const cycles = this._cycles.filter((c) => this._available?.has(c) ?? true);
      this._slots = blendedSlots(this._source, cycles);
    } else {
      this._slots = deterministicSlots(this._source, this._run);
    }
    this.renderTicks();
  }

  /**
   * Rebuild the slots and reselect the one nearest `validMs`. Reloads only if
   * that lands on a different cycle or hour, unless `force` is set.
   */
  private rebuild(validMs: number, force = false): void {
    const prevCycle = this.cycle;
    const prevFhour = this.fhour;
    this.rebuildSlots();
    const index = nearestSlotIndex(this._slots, validMs);
    const slot = this._slots[index];
    if (force || slot?.cycle !== prevCycle || slot?.fhour !== prevFhour) {
      this.selectIndex(index);
    } else {
      this._index = index;
      this.markActive();
    }
  }

  private renderTicks(): void {
    this.tickContainer.innerHTML = '';
    this.dayRow.innerHTML = '';

    // Group hours by local day for day labels
    interface DayGroup { label: string; count: number }
    const groups: DayGroup[] = [];
    let prevDayKey = '';
    const blended = new Set(this._slots.map((s) => s.cycle)).size > 1;

    this._slots.forEach((slot, index) => {
      const h = slot.fhour;
      const valid = new Date(slot.validMs);
      const dayKey = `${valid.getDay()}-${valid.getDate()}`;
      const hr = valid.getHours();
      const ampm = hr >= 12 ? 'p' : 'a';
      const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;

      const tick = document.createElement('button');
      tick.className = 'timeline-tick';
      tick.dataset.hour = String(h);
      const when = `${DAYS[valid.getDay()]!} ${h12}${ampm === 'p' ? 'pm' : 'am'}`;
      if (this._source === 'gefs') {
        // For long-range forecasts show day+hour for clarity
        tick.textContent = h <= 48 ? `${h12}${ampm}` : `d${Math.floor(h / 24)}`;
        tick.title = `f${String(h).padStart(3, '0')} ${when}`;
      } else {
        tick.textContent = `${h12}${ampm}`;
        tick.title = blended ? `t:${h} ${when} (${slot.cycle.slice(8, 10)}Z run)` : `t:${h} ${when}`;
      }
      tick.addEventListener('click', () => this.selectIndex(index));
      this.tickContainer.appendChild(tick);

      if (dayKey !== prevDayKey) {
        groups.push({ label: `${DAYS[valid.getDay()]!} ${valid.getMonth() + 1}/${valid.getDate()}`, count: 1 });
        prevDayKey = dayKey;
      } else {
        groups[groups.length - 1]!.count++;
      }
    });

    for (const g of groups) {
      const label = document.createElement('span');
      label.className = 'timeline-day-label';
      label.textContent = g.label;
      label.style.flex = String(g.count);
      this.dayRow.appendChild(label);
    }
  }

  private markActive(): void {
    [...this.tickContainer.children].forEach((el, i) => {
      const isActive = i === this._index;
      el.classList.toggle('active', isActive);
      if (isActive) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    this.updateValidLabel();
  }

  private selectIndex(index: number): void {
    this._index = index;
    this.markActive();
    this.pending = Promise.resolve(this.onChange(this.cycle, this.fhour)).catch(() => {});
  }

  /** Select a forecast hour on offer; hours are unique across blended runs. */
  selectHour(h: number): void {
    const index = this._slots.findIndex((s) => s.fhour === h);
    if (index >= 0) this.selectIndex(index);
  }

  /** Select the forecast hour closest to the current wall-clock time. */
  selectNow(): void {
    this.selectValidTime(Date.now());
  }

  /** True if `validMs` falls within the timeline's forecast range. */
  covers(validMs: number): boolean {
    const first = this._slots[0];
    const last = this._slots[this._slots.length - 1];
    return !!first && !!last && validMs >= first.validMs && validMs <= last.validMs;
  }

  /** Select the forecast hour whose valid time is closest to `validMs`. */
  selectValidTime(validMs: number): void {
    this.selectIndex(nearestSlotIndex(this._slots, validMs));
  }

  /** Start or stop looping playback through the forecast hours. */
  setPlaying(playing: boolean): void {
    if (playing === this.playing) return;
    this.playing = playing;
    this.updatePlayBtn();
    if (playing) void this.playLoop();
  }

  private async playLoop(): Promise<void> {
    while (this.playing) {
      await this.pending;
      await new Promise((r) => setTimeout(r, PLAY_DWELL_MS));
      if (!this.playing) return;
      if (this._slots.length === 0) return;
      this.selectIndex((this._index + 1) % this._slots.length);
    }
  }

  private updatePlayBtn(): void {
    this.playBtn.textContent = this.playing ? '⏸' : '▶';
    this.playBtn.title = this.playing ? 'Pause' : 'Play forecast';
  }

  /** Selectable slots for the current source, in valid-time order. */
  slots(): readonly TimelineSlot[] {
    return this._slots;
  }

  /** Step forward or backward through the slots on offer. */
  stepHour(delta: number): void {
    const next = Math.max(0, Math.min(this._slots.length - 1, this._index + delta));
    if (next !== this._index) this.selectIndex(next);
  }

  /** The selected slot's valid time. */
  validDate(): Date {
    return new Date(this._slots[this._index]?.validMs ?? Date.now());
  }

  private updateValidLabel(): void {
    const valid = this.validDate();
    const day = DAYS[valid.getDay()]!;
    const hour = valid.getHours();
    const ampm = hour >= 12 ? 'pm' : 'am';
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const mon = valid.getMonth() + 1;
    const date = valid.getDate();
    this.validLabel.innerHTML = `<span class="timeline-run">Valid: </span>${day} ${h12}${ampm} ${mon}/${date}`;
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function gefsRecentCyclesLocal(count: number): string[] {
  const now = new Date(Date.now() - 7 * 3600 * 1000); // ~7h production delay
  const cycleHour = Math.floor(now.getUTCHours() / 6) * 6;
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cycleHour));
  const cycles: string[] = [];
  for (let i = 0; i < count; i++) {
    cycles.push(formatCycle(new Date(base.getTime() - i * 6 * 3600 * 1000)));
  }
  return cycles;
}
