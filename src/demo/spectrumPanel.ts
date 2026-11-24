/**
 * Wave spectrum panel for one NDBC buoy. Floats over the map and shows,
 * for the hour picked on its own slider:
 *   - the 1-D energy spectrum E(f) against period or frequency,
 *   - the reconstructed directional spectrum S(f,θ) as a polar heatmap,
 *   - the wave systems (swell trains, wind sea) found by partitioning it.
 * Everything is drawn on Canvas 2D; no charting library.
 */

import {
  analyseRecord, clamp, compass, deg2rad, normDeg, rad2deg, significantWaveHeight,
} from '../waves/spectrum.js';
import type { DirectionalGrid, Partition, ReconMethod, SpectrumRecord } from '../waves/spectrum.js';

export interface SpectrumPanelOptions {
  parent: HTMLElement;
  onClose: () => void;
}

type AxisMode = 'period' | 'freq';

const N_DIR = 72;
const SWELL_COLOR = '#4fd1c5';
const SEA_COLOR = '#f6ad55';
const MUTED = '#8b949e';
const TEXT = '#e6edf3';
const GRID_LINE = 'rgba(139,148,158,0.3)';
/** Outer ring of the polar plot in period mode, seconds; rings every 5 s. */
const PERIOD_AXIS_MAX = 25;

export class SpectrumPanel {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private subtitleEl: HTMLElement;
  private body: HTMLElement;
  private message: HTMLElement;
  private slider: HTMLInputElement;
  private timeLabel: HTMLElement;
  private hsEl: HTMLElement;
  private axisSelect: HTMLSelectElement;
  private reconSelect: HTMLSelectElement;
  private specCanvas: HTMLCanvasElement;
  private polarCanvas: HTMLCanvasElement;
  private tooltip: HTMLElement;
  private tableBody: HTMLElement;
  private legendEl: HTMLElement;
  private linkEl: HTMLAnchorElement;

  private records: SpectrumRecord[] = [];
  private idx = 0;
  private axisMode: AxisMode = 'period';
  private recon: ReconMethod = 'fourier';
  private stationId = '';

  // Geometry of the last draw, for hover hit-testing.
  private specHit: { points: Array<{ x: number; y: number; i: number }>; rec: SpectrumRecord } | null = null;
  private polarHit: {
    grid: DirectionalGrid; rec: SpectrumRecord; cx: number; cy: number; maxR: number; vMax: number;
    fMin: number; fMax: number; rOf: (f: number) => number;
  } | null = null;

  constructor(opts: SpectrumPanelOptions) {
    this.root = document.createElement('div');
    this.root.id = 'spectrum-panel';
    this.root.style.display = 'none';
    this.root.innerHTML = `
      <div class="spectrum-header">
        <div>
          <div class="spectrum-title"></div>
          <div class="spectrum-subtitle"></div>
        </div>
        <button class="spectrum-close" title="Close">×</button>
      </div>
      <div class="spectrum-message"></div>
      <div class="spectrum-body">
        <div class="spectrum-row">
          <input class="spectrum-slider" type="range" min="0" max="0" value="0" step="1" />
          <span class="spectrum-time"></span>
        </div>
        <div class="spectrum-row spectrum-controls">
          <span class="spectrum-hs"></span>
          <select class="spectrum-axis" title="Radial / x axis">
            <option value="period">Period</option>
            <option value="freq">Frequency</option>
          </select>
          <select class="spectrum-recon" title="How S(f,θ) is rebuilt from α1, α2, r1, r2">
            <option value="fourier">Fourier (NDBC)</option>
            <option value="mem">Max entropy</option>
          </select>
        </div>
        <canvas class="spectrum-1d" width="336" height="150"></canvas>
        <canvas class="spectrum-polar" width="336" height="336"></canvas>
        <div class="spectrum-legend"></div>
        <table class="spectrum-table">
          <thead><tr><th>#</th><th>System</th><th>Hs</th><th>Tp</th><th>From</th></tr></thead>
          <tbody></tbody>
        </table>
        <div class="spectrum-foot">
          <a class="spectrum-link" target="_blank" rel="noopener">Station page at NDBC</a>
        </div>
      </div>
      <div class="spectrum-tooltip" role="tooltip"></div>`;

    const q = <T extends Element>(sel: string): T => this.root.querySelector(sel) as T;
    this.titleEl = q('.spectrum-title');
    this.subtitleEl = q('.spectrum-subtitle');
    this.body = q('.spectrum-body');
    this.message = q('.spectrum-message');
    this.slider = q('.spectrum-slider');
    this.timeLabel = q('.spectrum-time');
    this.hsEl = q('.spectrum-hs');
    this.axisSelect = q('.spectrum-axis');
    this.reconSelect = q('.spectrum-recon');
    this.specCanvas = q('.spectrum-1d');
    this.polarCanvas = q('.spectrum-polar');
    this.tooltip = q('.spectrum-tooltip');
    this.tableBody = q('.spectrum-table tbody');
    this.legendEl = q('.spectrum-legend');
    this.linkEl = q('.spectrum-link');

    q<HTMLButtonElement>('.spectrum-close').addEventListener('click', () => {
      this.close();
      opts.onClose();
    });
    this.slider.addEventListener('input', () => {
      this.idx = Number(this.slider.value);
      this.render();
    });
    this.axisSelect.addEventListener('change', () => {
      this.axisMode = this.axisSelect.value as AxisMode;
      this.render();
    });
    this.reconSelect.addEventListener('change', () => {
      this.recon = this.reconSelect.value as ReconMethod;
      this.render();
    });
    this.specCanvas.addEventListener('mousemove', (ev) => this.onSpecMove(ev));
    this.specCanvas.addEventListener('mouseleave', () => this.hideTooltip());
    this.polarCanvas.addEventListener('mousemove', (ev) => this.onPolarMove(ev));
    this.polarCanvas.addEventListener('mouseleave', () => this.hideTooltip());

    for (const c of [this.specCanvas, this.polarCanvas]) scaleForDpr(c);
    opts.parent.appendChild(this.root);
  }

  get isOpen(): boolean { return this.root.style.display !== 'none'; }
  get station(): string { return this.stationId; }

  /** Show the panel for a station in its loading state. */
  open(stationId: string, name: string): void {
    this.stationId = stationId;
    this.titleEl.textContent = name ? `${name}` : `Station ${stationId}`;
    this.subtitleEl.textContent = name ? `NDBC ${stationId}` : '';
    this.linkEl.href = `https://www.ndbc.noaa.gov/station_page.php?station=${encodeURIComponent(stationId.toLowerCase())}`;
    this.records = [];
    this.body.style.display = 'none';
    this.showMessage('Loading spectra…');
    this.root.style.display = '';
    document.documentElement.classList.add('spectrum-open');
  }

  showMessage(text: string): void {
    this.message.textContent = text;
    this.message.style.display = '';
    this.body.style.display = 'none';
  }

  /** Records oldest first; the newest is selected. */
  setRecords(records: SpectrumRecord[]): void {
    this.records = records;
    if (records.length === 0) {
      this.showMessage('No spectral records in the last few days.');
      return;
    }
    this.idx = records.length - 1;
    this.slider.max = String(records.length - 1);
    this.slider.value = String(this.idx);
    this.message.style.display = 'none';
    this.body.style.display = '';
    this.render();
  }

  close(): void {
    this.root.style.display = 'none';
    this.hideTooltip();
    document.documentElement.classList.remove('spectrum-open');
  }

  // ------------------------------------------------------------- rendering

  private render(): void {
    const rec = this.records[this.idx];
    if (!rec) return;
    this.timeLabel.textContent = `${rec.time.replace('T', ' ')} UTC`;
    const hs = significantWaveHeight(rec.freqs, rec.energy);
    this.hsEl.textContent = `Hs ${hs.toFixed(2)} m`;

    this.drawSpectrum(rec);
    const { grid, partitions } = analyseRecord(rec, N_DIR, this.recon);
    if (rec.hasDirection) {
      this.drawPolar(grid, rec, partitions);
      this.renderTable(partitions);
      this.legendEl.innerHTML =
        `Direction waves come <b>from</b> · radius = ${this.axisMode === 'period' ? 'period' : 'frequency'}`
        + ` · <span style="color:${SWELL_COLOR}">●</span> swell <span style="color:${SEA_COLOR}">●</span> wind sea`;
    } else {
      this.clearPolar();
      this.tableBody.innerHTML = '<tr><td colspan="5" class="spectrum-muted">No directional data for this hour.</td></tr>';
      this.legendEl.textContent = '';
    }
  }

  private drawSpectrum(rec: SpectrumRecord): void {
    const canvas = this.specCanvas;
    const ctx = canvas.getContext('2d')!;
    const W = logicalWidth(canvas);
    const H = logicalHeight(canvas);
    ctx.clearRect(0, 0, W, H);
    const usePeriod = this.axisMode === 'period';

    // x is always period so bins never reorder when the axis mode flips:
    // short periods (high frequency) left, long periods right.
    const points = rec.freqs.map((f, i) => ({ x: 1 / f, y: rec.energy[i] ?? 0, i })).sort((a, b) => a.x - b.x);
    const xMin = points[0]!.x;
    const xMax = Math.min(points[points.length - 1]!.x, PERIOD_AXIS_MAX);
    const yMax = Math.max(1e-3, ...points.map((p) => p.y)) * 1.08;

    const padL = 36;
    const padR = 8;
    const padT = 8;
    const padB = 24;
    const plotW = W - padL - padR;
    const plotH = H - padT - padB;
    const sx = (x: number): number => padL + ((clamp(x, xMin, xMax) - xMin) / (xMax - xMin)) * plotW;
    const sy = (y: number): number => padT + plotH - (y / yMax) * plotH;

    // Grid and ticks
    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.fillStyle = MUTED;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = usePeriod ? [5, 10, 15, 20, 25] : [0.05, 0.1, 0.15, 0.2, 0.3, 0.4];
    for (const t of xTicks) {
      const x = usePeriod ? t : 1 / t;
      if (x < xMin || x > xMax) continue;
      const px = sx(x);
      ctx.beginPath();
      ctx.moveTo(px, padT);
      ctx.lineTo(px, padT + plotH);
      ctx.stroke();
      ctx.fillText(usePeriod ? `${t}s` : `${t}`, px, padT + plotH + 4);
    }
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let k = 0; k <= 3; k++) {
      const y = (yMax / 3) * k;
      const py = sy(y);
      ctx.beginPath();
      ctx.moveTo(padL, py);
      ctx.lineTo(padL + plotW, py);
      ctx.stroke();
      ctx.fillText(y >= 10 ? y.toFixed(0) : y.toFixed(1), padL - 4, py);
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(usePeriod ? 'period' : 'Hz', padL + plotW - 36, padT);
    ctx.save();
    ctx.translate(10, padT + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('m²/Hz', 0, 0);
    ctx.restore();

    // Area + line
    ctx.beginPath();
    ctx.moveTo(sx(points[0]!.x), sy(0));
    for (const p of points) ctx.lineTo(sx(p.x), sy(p.y));
    ctx.lineTo(sx(points[points.length - 1]!.x), sy(0));
    ctx.closePath();
    ctx.fillStyle = 'rgba(79,209,197,0.18)';
    ctx.fill();
    ctx.beginPath();
    for (const [k, p] of points.entries()) {
      if (k === 0) ctx.moveTo(sx(p.x), sy(p.y));
      else ctx.lineTo(sx(p.x), sy(p.y));
    }
    ctx.strokeStyle = SWELL_COLOR;
    ctx.lineWidth = 2;
    ctx.stroke();

    this.specHit = { points: points.map((p) => ({ x: sx(p.x), y: sy(p.y), i: p.i })), rec };
  }

  private clearPolar(): void {
    const ctx = this.polarCanvas.getContext('2d')!;
    const W = logicalWidth(this.polarCanvas);
    const H = logicalHeight(this.polarCanvas);
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = MUTED;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('No directional spectrum (α1, α2, r1, r2) for this hour', W / 2, H / 2);
    this.polarHit = null;
  }

  private drawPolar(grid: DirectionalGrid, rec: SpectrumRecord, partitions: Partition[]): void {
    const canvas = this.polarCanvas;
    const ctx = canvas.getContext('2d')!;
    const W = logicalWidth(canvas);
    const H = logicalHeight(canvas);
    ctx.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const maxR = Math.min(W, H) / 2 - 22;
    const { values, dirs, nFreq, nDir } = grid;
    const freqs = rec.freqs;
    const usePeriod = this.axisMode === 'period';

    // Period mode: fixed 0-25 s rings so plots compare across buoys and
    // hours. Frequency mode: auto-scale to where the energy actually is.
    const fMin = usePeriod ? freqs[0]! : effectiveMinFreq(freqs, rec.energy);
    const fMax = usePeriod ? freqs[freqs.length - 1]! : effectiveMaxFreq(freqs, rec.energy);

    let vMax = 0;
    for (let i = 0; i < nFreq; i++) {
      if (freqs[i]! < fMin || freqs[i]! > fMax) continue;
      for (let j = 0; j < nDir; j++) vMax = Math.max(vMax, values[i * nDir + j]!);
    }
    if (vMax <= 0) vMax = 1;

    const rOf = (f: number): number => {
      if (usePeriod) return (maxR * clamp(1 / f, 0, PERIOD_AXIS_MAX)) / PERIOD_AXIS_MAX;
      return (maxR * (clamp(f, fMin, fMax) - fMin)) / (fMax - fMin);
    };
    const xyOf = (r: number, thDeg: number): [number, number] => {
      const a = deg2rad(thDeg - 90);
      return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    };

    const dTheta = 360 / nDir;
    for (let i = 0; i < nFreq - 1; i++) {
      if (freqs[i + 1]! < fMin) continue;
      if (freqs[i]! > fMax) break;
      const r0 = rOf(freqs[i]!);
      const r1 = rOf(freqs[i + 1]!);
      for (let j = 0; j < nDir; j++) {
        const v = values[i * nDir + j]!;
        if (v <= 0) continue;
        drawAnnularSector(ctx, cx, cy, r0, r1, dirs[j]! - dTheta / 2, dirs[j]! + dTheta / 2, heatColor(v / vMax));
      }
    }

    ctx.strokeStyle = GRID_LINE;
    ctx.lineWidth = 1;
    ctx.fillStyle = MUTED;
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    if (usePeriod) {
      for (const p of [5, 10, 15, 20, 25]) {
        const r = rOf(1 / p);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillText(`${p}s`, cx, cy - r - 2);
      }
    } else {
      for (let k = 1; k <= 4; k++) {
        const f = fMin + ((fMax - fMin) * k) / 4;
        const r = rOf(f);
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, 2 * Math.PI);
        ctx.stroke();
        ctx.fillText(`${f.toFixed(2)}`, cx, cy - r - 2);
      }
    }
    ctx.textBaseline = 'middle';
    ['N', 'E', 'S', 'W'].forEach((label, k) => {
      const ang = k * 90;
      const [sx, sy] = xyOf(0, ang);
      const [ex, ey] = xyOf(maxR, ang);
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      const [lx, ly] = xyOf(maxR + 12, ang);
      ctx.fillStyle = TEXT;
      ctx.fillText(label, lx, ly);
      ctx.fillStyle = MUTED;
    });

    // Wave systems: a dot at (peak period, mean direction from), numbered as in the table.
    partitions.forEach((p, i) => {
      const [x, y] = xyOf(rOf(clamp(p.peakFreq, fMin, fMax)), p.meanDir);
      ctx.fillStyle = p.type === 'swell' ? SWELL_COLOR : SEA_COLOR;
      ctx.beginPath();
      ctx.arc(x, y, 4 + Math.min(p.hs * 2.5, 8), 0, 2 * Math.PI);
      ctx.fill();
      ctx.strokeStyle = '#0b0d10';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = TEXT;
      ctx.font = 'bold 11px ui-monospace, SFMono-Regular, Menlo, monospace';
      ctx.fillText(String(i + 1), x, y - 13);
    });

    this.polarHit = { grid, rec, cx, cy, maxR, vMax, fMin, fMax, rOf };
  }

  private renderTable(partitions: Partition[]): void {
    if (partitions.length === 0) {
      this.tableBody.innerHTML = '<tr><td colspan="5" class="spectrum-muted">No significant wave systems.</td></tr>';
      return;
    }
    this.tableBody.innerHTML = partitions.map((p, i) => `
      <tr>
        <td style="color:${p.type === 'swell' ? SWELL_COLOR : SEA_COLOR}">${i + 1}</td>
        <td>${p.type === 'swell' ? 'Swell' : 'Wind sea'}</td>
        <td>${p.hs.toFixed(2)} m</td>
        <td>${p.peakPeriod.toFixed(1)} s</td>
        <td>${p.meanDir.toFixed(0)}° ${compass(p.meanDir)}</td>
      </tr>`).join('');
  }

  // ---------------------------------------------------------------- hover

  private onSpecMove(ev: MouseEvent): void {
    const hit = this.specHit;
    if (!hit) return this.hideTooltip();
    const [mx] = canvasPoint(this.specCanvas, ev);
    let best = hit.points[0]!;
    for (const p of hit.points) if (Math.abs(p.x - mx) < Math.abs(best.x - mx)) best = p;
    const rec = hit.rec;
    const f = rec.freqs[best.i]!;
    const lines = [
      `<b>${(1 / f).toFixed(1)} s</b> · ${f.toFixed(3)} Hz`,
      `E(f) = ${(rec.energy[best.i] ?? 0).toFixed(3)} m²/Hz`,
    ];
    if (rec.hasDirection && rec.alpha1 && rec.r1) {
      const a1 = rec.alpha1[best.i]!;
      lines.push(`from ${normDeg(a1).toFixed(0)}° ${compass(a1)} · spread r1 ${rec.r1[best.i]!.toFixed(2)}`);
    }
    this.showTooltip(ev, lines.join('<br>'));
  }

  private onPolarMove(ev: MouseEvent): void {
    const hit = this.polarHit;
    if (!hit) return this.hideTooltip();
    const [mx, my] = canvasPoint(this.polarCanvas, ev);
    const dx = mx - hit.cx;
    const dy = my - hit.cy;
    const r = Math.hypot(dx, dy);
    if (r > hit.maxR) return this.hideTooltip();

    const { grid, rec } = hit;
    const freqs = rec.freqs;
    // Sector i spans rOf(freqs[i])..rOf(freqs[i+1]); compare on radius since
    // period mode runs the other way to frequency mode.
    let i = -1;
    for (let k = 0; k < grid.nFreq - 1; k++) {
      const ra = hit.rOf(freqs[k]!);
      const rb = hit.rOf(freqs[k + 1]!);
      if (r >= Math.min(ra, rb) && r <= Math.max(ra, rb)) { i = k; break; }
    }
    if (i < 0) return this.hideTooltip();
    const thDeg = normDeg(rad2deg(Math.atan2(dy, dx)) + 90);
    const j = Math.round(thDeg / (360 / grid.nDir)) % grid.nDir;
    const f = freqs[i]!;
    const v = grid.values[i * grid.nDir + j]!;
    const dir = grid.dirs[j]!;
    this.showTooltip(ev, [
      `<b>${dir.toFixed(0)}° ${compass(dir)}</b> · ${(1 / f).toFixed(1)} s (${f.toFixed(3)} Hz)`,
      `S(f,θ) = ${v.toFixed(3)} m²/Hz/rad · ${((100 * v) / hit.vMax).toFixed(0)}% of peak`,
      `E(f) = ${(rec.energy[i] ?? 0).toFixed(3)} m²/Hz`,
    ].join('<br>'));
  }

  private showTooltip(ev: MouseEvent, html: string): void {
    const tip = this.tooltip;
    tip.innerHTML = html;
    tip.style.display = 'block';
    const box = this.root.getBoundingClientRect();
    let left = ev.clientX - box.left + 14;
    let top = ev.clientY - box.top + this.root.scrollTop + 14;
    if (left + tip.offsetWidth > box.width - 8) left = ev.clientX - box.left - tip.offsetWidth - 14;
    if (ev.clientY + tip.offsetHeight + 14 > box.bottom) top -= tip.offsetHeight + 28;
    tip.style.left = `${Math.max(4, left)}px`;
    tip.style.top = `${Math.max(4, top)}px`;
  }

  private hideTooltip(): void {
    this.tooltip.style.display = 'none';
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Render at device resolution while keeping the CSS size the attributes gave. */
function scaleForDpr(canvas: HTMLCanvasElement): void {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.width;
  const h = canvas.height;
  canvas.dataset.w = String(w);
  canvas.dataset.h = String(h);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.getContext('2d')!.setTransform(dpr, 0, 0, dpr, 0, 0);
}
const logicalWidth = (c: HTMLCanvasElement): number => Number(c.dataset.w ?? c.width);
const logicalHeight = (c: HTMLCanvasElement): number => Number(c.dataset.h ?? c.height);

/** Mouse position in a canvas's logical (CSS pixel) coordinates. */
function canvasPoint(canvas: HTMLCanvasElement, ev: MouseEvent): [number, number] {
  const rect = canvas.getBoundingClientRect();
  return [
    ((ev.clientX - rect.left) * logicalWidth(canvas)) / rect.width,
    ((ev.clientY - rect.top) * logicalHeight(canvas)) / rect.height,
  ];
}

function drawAnnularSector(
  ctx: CanvasRenderingContext2D, cx: number, cy: number, r0: number, r1: number,
  th0Deg: number, th1Deg: number, color: string,
): void {
  const a0 = deg2rad(th0Deg - 90);
  const a1 = deg2rad(th1Deg - 90);
  ctx.beginPath();
  ctx.arc(cx, cy, r1, a0, a1, false);
  ctx.arc(cx, cy, r0, a1, a0, true);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

const HEAT_STOPS: Array<[number, number, number]> = [
  [11, 18, 32], [37, 88, 130], [79, 209, 197], [246, 213, 92], [246, 173, 85],
];

/** Dark blue → teal → yellow → orange ramp for 0..1. */
function heatColor(t: number): string {
  const s = clamp(t, 0, 1) * (HEAT_STOPS.length - 1);
  const i0 = Math.floor(s);
  const i1 = Math.min(i0 + 1, HEAT_STOPS.length - 1);
  const f = s - i0;
  const c0 = HEAT_STOPS[i0]!;
  const c1 = HEAT_STOPS[i1]!;
  const c = c0.map((v, k) => Math.round(v + (c1[k]! - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/** Highest frequency worth plotting: past the last bin above 1.5 % of peak, plus a margin. */
function effectiveMaxFreq(freqs: number[], energy: number[]): number {
  const maxE = Math.max(1e-9, ...energy);
  let last = 0;
  for (let i = 0; i < energy.length; i++) if (energy[i]! > 0.015 * maxE) last = i;
  const padded = Math.min(freqs.length - 1, last + 4);
  return Math.max(freqs[padded]!, freqs[0]! + 0.15);
}

function effectiveMinFreq(freqs: number[], energy: number[]): number {
  const maxE = Math.max(1e-9, ...energy);
  let first = freqs.length - 1;
  for (let i = energy.length - 1; i >= 0; i--) if (energy[i]! > 0.03 * maxE) first = i;
  const padded = Math.max(0, first - 1);
  return Math.min(freqs[padded]!, freqs[freqs.length - 1]! - 0.02);
}
