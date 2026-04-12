/**
 * Forecast timeline control. Shows a cycle selector and a horizontal bar of
 * forecast-hour ticks. Clicking a tick fires the onChange callback.
 */

export interface TimelineOptions {
  parent: HTMLElement;
  onChange: (cycle: string, fhour: number) => void;
}

export class Timeline {
  private cycleSelect: HTMLSelectElement;
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
    cycleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;';
    const cycleLabel = document.createElement('span');
    cycleLabel.textContent = 'Cycle';
    cycleLabel.style.cssText = 'color:#8b949e;font-size:11px;';
    this.cycleSelect = document.createElement('select');
    this.cycleSelect.style.cssText = 'flex:1;';
    this.validLabel = document.createElement('span');
    this.validLabel.style.cssText = 'color:#7ee787;font-size:11px;margin-left:auto;';
    cycleRow.append(cycleLabel, this.cycleSelect, this.validLabel);

    // Tick bar
    this.tickContainer = document.createElement('div');
    this.tickContainer.className = 'timeline-ticks';
    this.tickContainer.style.cssText =
      'display:flex;gap:1px;overflow-x:auto;padding:2px 0;';

    wrapper.append(cycleRow, this.tickContainer);
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
      this._cycle = this.cycleSelect.value;
      this.rebuildTicks();
      this.selectHour(Math.min(this._fhour, this._maxHour));
    });

    this.rebuildTicks();
    this.selectHour(0);
  }

  private rebuildTicks(): void {
    const hh = Number(this._cycle.slice(8, 10));
    this._maxHour = hh % 6 === 0 ? 48 : 18;
    this.tickContainer.innerHTML = '';
    for (let h = 0; h <= this._maxHour; h++) {
      const tick = document.createElement('button');
      tick.className = 'timeline-tick';
      tick.dataset.hour = String(h);
      tick.textContent = String(h);
      tick.title = `f${String(h).padStart(2, '0')}`;
      tick.addEventListener('click', () => this.selectHour(h));
      this.tickContainer.appendChild(tick);
    }
  }

  selectHour(h: number): void {
    this._fhour = h;
    // Highlight active tick
    for (const el of this.tickContainer.children) {
      const tickEl = el as HTMLElement;
      const isActive = el.getAttribute('data-hour') === String(h);
      tickEl.classList.toggle('active', isActive);
      // Scroll active tick into view
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

  private updateValidLabel(): void {
    // Compute valid time from cycle + fhour
    const y = Number(this._cycle.slice(0, 4));
    const m = Number(this._cycle.slice(4, 6)) - 1;
    const d = Number(this._cycle.slice(6, 8));
    const hh = Number(this._cycle.slice(8, 10));
    const valid = new Date(Date.UTC(y, m, d, hh + this._fhour));
    const pad = (n: number) => String(n).padStart(2, '0');
    this.validLabel.textContent =
      `Valid: ${pad(valid.getUTCHours())}Z ${pad(valid.getUTCMonth() + 1)}/${pad(valid.getUTCDate())}`;
  }
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
