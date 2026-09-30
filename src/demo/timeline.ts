/**
 * Forecast timeline control. Shows a cycle selector and a horizontal bar of
 * forecast-hour ticks grouped by day with labels and dividers.
 */

export interface TimelineOptions {
  parent: HTMLElement;
  onChange: (cycle: string, fhour: number) => void;
  /**
   * Optional availability check for a deterministic model cycle. Cycles that
   * resolve false are disabled in the dropdown, and if the selected cycle is
   * missing the timeline moves to the newest one that exists.
   */
  probeCycle?: (model: DeterministicModel, cycle: string) => Promise<boolean>;
}

export type DeterministicModel = 'hrrr' | 'rrfs';
export type TimelineSource = DeterministicModel | 'gefs';

const MODEL_LABELS: Record<DeterministicModel, string> = { hrrr: 'HRRR', rrfs: 'RRFS' };

export class Timeline {
  private cycleSelect: HTMLSelectElement;
  private modelSelect: HTMLSelectElement;
  private dayRow: HTMLElement;
  private tickContainer: HTMLElement;
  private validLabel: HTMLElement;
  private _cycle = '';
  private _fhour = 0;
  private _maxHour = 18;
  private _source: TimelineSource = 'hrrr';
  private _model: DeterministicModel = 'hrrr';
  private _gefsFhours: number[] | null = null;
  private onChange: (cycle: string, fhour: number) => void;
  private probeCycle: TimelineOptions['probeCycle'];
  private probeGen = 0;

  get cycle(): string { return this._cycle; }
  get fhour(): number { return this._fhour; }
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
    cycleLabel.style.cssText = 'color:#8b949e;font-size:11px;';
    this.modelSelect = document.createElement('select');
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
    this.cycleSelect.style.cssText = 'width:auto;';
    this.validLabel = document.createElement('span');
    this.validLabel.style.cssText = 'color:#7ee787;font-size:11px;';
    cycleRow.append(cycleLabel, this.modelSelect, this.cycleSelect, this.validLabel);

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
      this.switchCyclePreservingValid(this.cycleSelect.value);
    });

    this.rebuildTicks();
    this.selectHour(0);
    this.probeCycles();
  }

  /**
   * Switch the timeline between deterministic (HRRR/RRFS) and GEFS modes.
   * Passing a deterministic source also makes it the current model.
   */
  setSource(source: TimelineSource, gefsFhours?: number[]): void {
    if (source === this._source) return;
    this._source = source;
    this._gefsFhours = source === 'gefs' && gefsFhours ? gefsFhours : null;
    if (source !== 'gefs') {
      this._model = source;
      this.modelSelect.value = source;
    }
    this.modelSelect.disabled = source === 'gefs';

    this.populateCycles();
    this.rebuildTicks();
    this.selectHour(0);
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
    if (this._source === 'gefs') return;
    const prevValidMs = this.validDate().getTime();
    this._source = model;
    this.populateCycles();
    this.switchCycleToValid(this._cycle, prevValidMs);
    this.probeCycles();
  }

  get source(): TimelineSource { return this._source; }

  private populateCycles(): void {
    const cycles = this._source === 'gefs'
      ? gefsRecentCyclesLocal(4)
      // The RRFS parallel feed occasionally skips cycles, so offer a few more.
      : recentCycles(this._source === 'rrfs' ? 8 : 6);
    this.cycleSelect.innerHTML = '';
    for (const c of cycles) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)} ${c.slice(8, 10)}Z`;
      this.cycleSelect.appendChild(opt);
    }
    this._cycle = cycles[0] ?? '';
  }

  /** Preserve the same valid (calendar) time when switching cycles. */
  private switchCyclePreservingValid(cycle: string): void {
    this.switchCycleToValid(cycle, this.validDate().getTime());
  }

  private switchCycleToValid(cycle: string, validMs: number): void {
    this._cycle = cycle;
    this.cycleSelect.value = cycle;
    this.rebuildTicks();
    const newCycleMs = parseCycleUTC(this._cycle).getTime();
    const desiredFhour = Math.round((validMs - newCycleMs) / 3600000);
    const clamped = Math.max(0, Math.min(this._maxHour, desiredFhour));
    this.selectHour(clamped);
  }

  /**
   * Check which listed cycles actually exist, disabling missing ones. If the
   * selected cycle is missing, move to the newest available cycle.
   */
  private probeCycles(): void {
    if (!this.probeCycle || this._source === 'gefs') return;
    const gen = ++this.probeGen;
    const model = this._source;
    const options = [...this.cycleSelect.options];
    void Promise.all(options.map((o) => this.probeCycle!(model, o.value).catch(() => false)))
      .then((results) => {
        if (gen !== this.probeGen) return;
        options.forEach((o, i) => {
          o.disabled = !results[i];
          if (!results[i]) o.textContent += ' (unavailable)';
        });
        const current = options.find((o) => o.value === this._cycle);
        if (current?.disabled) {
          const firstOk = options.find((o) => !o.disabled);
          if (firstOk) this.switchCyclePreservingValid(firstOk.value);
        }
      });
  }

  private rebuildTicks(): void {
    if (this._source === 'gefs') {
      this.rebuildGefsMode();
      return;
    }
    const cycleHH = Number(this._cycle.slice(8, 10));
    const longRange = this._source === 'rrfs' ? 84 : 48;
    this._maxHour = cycleHH % 6 === 0 ? longRange : 18;
    this.tickContainer.innerHTML = '';
    this.dayRow.innerHTML = '';

    const cycleMs = parseCycleUTC(this._cycle).getTime();

    // Group hours by local day for day labels
    interface DayGroup { label: string; count: number }
    const groups: DayGroup[] = [];
    let prevDayKey = '';

    for (let h = 0; h <= this._maxHour; h++) {
      const valid = new Date(cycleMs + h * 3600000);
      const dayKey = `${valid.getDay()}-${valid.getDate()}`;
      const hr = valid.getHours();
      const ampm = hr >= 12 ? 'p' : 'a';
      const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;

      const tick = document.createElement('button');
      tick.className = 'timeline-tick';
      tick.dataset.hour = String(h);
      tick.textContent = `${h12}${ampm}`;
      tick.title = `t:${h} ${DAYS[valid.getDay()]!} ${h12}${ampm === 'p' ? 'pm' : 'am'}`;
      tick.addEventListener('click', () => this.selectHour(h));
      this.tickContainer.appendChild(tick);

      if (dayKey !== prevDayKey) {
        groups.push({ label: `${DAYS[valid.getDay()]!} ${valid.getMonth() + 1}/${valid.getDate()}`, count: 1 });
        prevDayKey = dayKey;
      } else {
        groups[groups.length - 1]!.count++;
      }
    }

    for (const g of groups) {
      const label = document.createElement('span');
      label.className = 'timeline-day-label';
      label.textContent = g.label;
      label.style.flex = String(g.count);
      this.dayRow.appendChild(label);
    }
  }

  private rebuildGefsMode(): void {
    const fhours = this._gefsFhours ?? [];
    this._maxHour = fhours.length > 0 ? fhours[fhours.length - 1]! : 384;
    this.tickContainer.innerHTML = '';
    this.dayRow.innerHTML = '';

    const cycleMs = parseCycleUTC(this._cycle).getTime();

    interface DayGroup { label: string; count: number }
    const groups: DayGroup[] = [];
    let prevDayKey = '';

    for (const h of fhours) {
      const valid = new Date(cycleMs + h * 3600000);
      const dayKey = `${valid.getDay()}-${valid.getDate()}`;
      const hr = valid.getHours();
      const ampm = hr >= 12 ? 'p' : 'a';
      const h12 = hr === 0 ? 12 : hr > 12 ? hr - 12 : hr;

      const tick = document.createElement('button');
      tick.className = 'timeline-tick';
      tick.dataset.hour = String(h);
      // For long-range forecasts show day+hour for clarity
      tick.textContent = h <= 48 ? `${h12}${ampm}` : `d${Math.floor(h / 24)}`;
      tick.title = `f${String(h).padStart(3, '0')} ${DAYS[valid.getDay()]!} ${h12}${ampm === 'p' ? 'pm' : 'am'}`;
      tick.addEventListener('click', () => this.selectHour(h));
      this.tickContainer.appendChild(tick);

      if (dayKey !== prevDayKey) {
        groups.push({ label: `${DAYS[valid.getDay()]!} ${valid.getMonth() + 1}/${valid.getDate()}`, count: 1 });
        prevDayKey = dayKey;
      } else {
        groups[groups.length - 1]!.count++;
      }
    }

    for (const g of groups) {
      const label = document.createElement('span');
      label.className = 'timeline-day-label';
      label.textContent = g.label;
      label.style.flex = String(g.count);
      this.dayRow.appendChild(label);
    }
  }

  selectHour(h: number): void {
    this._fhour = h;
    for (const el of this.tickContainer.children) {
      const tickEl = el as HTMLElement;
      const isActive = el.getAttribute('data-hour') === String(h);
      tickEl.classList.toggle('active', isActive);
      if (isActive) tickEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    this.updateValidLabel();
    this.onChange(this._cycle, this._fhour);
  }

  /** Step forward or backward. For GEFS, steps to next/prev valid forecast hour. */
  stepHour(delta: number): void {
    if (this._source === 'gefs' && this._gefsFhours) {
      const fh = this._gefsFhours;
      const curIdx = fh.indexOf(this._fhour);
      const nextIdx = Math.max(0, Math.min(fh.length - 1, (curIdx >= 0 ? curIdx : 0) + delta));
      const next = fh[nextIdx]!;
      if (next !== this._fhour) this.selectHour(next);
    } else {
      const next = Math.max(0, Math.min(this._maxHour, this._fhour + delta));
      if (next !== this._fhour) this.selectHour(next);
    }
  }

  /** Compute the valid Date from cycle + fhour. */
  validDate(): Date {
    return new Date(parseCycleUTC(this._cycle).getTime() + this._fhour * 3600000);
  }

  private updateValidLabel(): void {
    const valid = this.validDate();
    const day = DAYS[valid.getDay()]!;
    const hour = valid.getHours();
    const ampm = hour >= 12 ? 'pm' : 'am';
    const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
    const mon = valid.getMonth() + 1;
    const date = valid.getDate();
    this.validLabel.textContent = `Valid: ${day} ${h12}${ampm} ${mon}/${date}`;
  }
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function parseCycleUTC(cycle: string): Date {
  return new Date(Date.UTC(
    Number(cycle.slice(0, 4)),
    Number(cycle.slice(4, 6)) - 1,
    Number(cycle.slice(6, 8)),
    Number(cycle.slice(8, 10)),
  ));
}

function recentCycles(count: number): string[] {
  const now = new Date(Date.now() - 3 * 3600 * 1000);
  const cycles: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(now.getTime() - i * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    cycles.push(`${y}${m}${day}${h}`);
  }
  return cycles;
}

function gefsRecentCyclesLocal(count: number): string[] {
  const now = new Date(Date.now() - 7 * 3600 * 1000); // ~7h production delay
  const cycleHour = Math.floor(now.getUTCHours() / 6) * 6;
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), cycleHour));
  const cycles: string[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(base.getTime() - i * 6 * 3600 * 1000);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const h = String(d.getUTCHours()).padStart(2, '0');
    cycles.push(`${y}${m}${day}${h}`);
  }
  return cycles;
}
