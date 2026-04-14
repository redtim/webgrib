/**
 * Forecast timeline control. Shows a cycle selector and a horizontal bar of
 * forecast-hour ticks grouped by day with labels and dividers.
 */

export interface TimelineOptions {
  parent: HTMLElement;
  onChange: (cycle: string, fhour: number) => void;
}

export class Timeline {
  private cycleSelect: HTMLSelectElement;
  private dayRow: HTMLElement;
  private tickContainer: HTMLElement;
  private validLabel: HTMLElement;
  private _cycle = '';
  private _fhour = 0;
  private _maxHour = 18;
  private onChange: (cycle: string, fhour: number) => void;

  get cycle(): string { return this._cycle; }
  get fhour(): number { return this._fhour; }

  constructor(opts: TimelineOptions) {
    this.onChange = opts.onChange;

    const wrapper = document.createElement('div');
    wrapper.className = 'timeline';

    // Cycle row
    const cycleRow = document.createElement('div');
    cycleRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:4px;justify-content:center;';
    const cycleLabel = document.createElement('span');
    cycleLabel.textContent = 'Model Run';
    cycleLabel.style.cssText = 'color:#8b949e;font-size:11px;';
    this.cycleSelect = document.createElement('select');
    this.cycleSelect.style.cssText = 'width:auto;';
    this.validLabel = document.createElement('span');
    this.validLabel.style.cssText = 'color:#7ee787;font-size:11px;';
    cycleRow.append(cycleLabel, this.cycleSelect, this.validLabel);

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

    // Populate cycles
    const cycles = recentCycles(6);
    for (const c of cycles) {
      const opt = document.createElement('option');
      opt.value = c;
      opt.textContent = `${c.slice(0, 4)}-${c.slice(4, 6)}-${c.slice(6, 8)} ${c.slice(8, 10)}Z`;
      this.cycleSelect.appendChild(opt);
    }
    this._cycle = cycles[0] ?? '';
    this.cycleSelect.addEventListener('change', () => {
      // Preserve the same valid (calendar) time when switching cycles.
      const prevValidMs = this.validDate().getTime();
      this._cycle = this.cycleSelect.value;
      this.rebuildTicks();
      const newCycleMs = parseCycleUTC(this._cycle).getTime();
      const desiredFhour = Math.round((prevValidMs - newCycleMs) / 3600000);
      const clamped = Math.max(0, Math.min(this._maxHour, desiredFhour));
      this.selectHour(clamped);
    });

    this.rebuildTicks();
    this.selectHour(0);
  }

  private rebuildTicks(): void {
    const cycleHH = Number(this._cycle.slice(8, 10));
    this._maxHour = cycleHH % 6 === 0 ? 48 : 18;
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

    // Build day label spans — each spans the width of its tick group.
    // We measure tick width after render, but since ticks are uniform we can
    // use a proportional flex approach.
    for (const g of groups) {
      const label = document.createElement('span');
      label.className = 'timeline-day-label';
      label.textContent = g.label;
      // Each tick is ~min-width 20px + 1px gap. Use flex to match.
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

  /** Step forward or backward by delta hours. Clamps to [0, maxHour]. */
  stepHour(delta: number): void {
    const next = Math.max(0, Math.min(this._maxHour, this._fhour + delta));
    if (next !== this._fhour) this.selectHour(next);
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
