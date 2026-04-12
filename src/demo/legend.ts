/**
 * Colorbar / legend component. Renders a horizontal gradient bar with
 * tick labels and a unit string. Updates when the active layer changes.
 */

import { colormap } from '../renderer/colormaps.js';
import type { ColormapName } from '../renderer/colormaps.js';

export interface LegendTick {
  /** Display value (in the unit shown on the legend, e.g. knots) */
  value: number;
  /** Label text shown below the gradient bar */
  label: string;
}

export class Legend {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private tickRow: HTMLDivElement;

  constructor(parent: HTMLElement) {
    this.container = document.createElement('div');
    this.container.className = 'legend';
    this.container.style.cssText = 'margin-top:8px;display:none;';

    this.canvas = document.createElement('canvas');
    this.canvas.width = 256;
    this.canvas.height = 12;
    this.canvas.style.cssText = 'width:100%;height:12px;border-radius:2px;';

    this.tickRow = document.createElement('div');

    this.container.append(this.canvas, this.tickRow);
    parent.appendChild(this.container);
  }

  /**
   * Update the legend with custom positioned tick marks.
   * @param cmap      colormap name
   * @param dataMin   data-range minimum (display units)
   * @param dataMax   data-range maximum (display units)
   * @param unit      unit label string (e.g. 'kt')
   * @param ticks     array of tick marks with values and labels
   */
  update(
    cmap: ColormapName,
    dataMin: number,
    dataMax: number,
    unit: string,
    ticks?: LegendTick[],
  ): void {
    this.container.style.display = '';
    const rgba = colormap(cmap);
    const ctx = this.canvas.getContext('2d')!;
    const img = ctx.createImageData(256, 1);
    img.data.set(rgba);
    ctx.putImageData(img, 0, 0);
    ctx.drawImage(this.canvas, 0, 0, 256, 1, 0, 0, 256, 12);

    // Clear previous ticks
    this.tickRow.innerHTML = '';

    if (ticks && ticks.length > 0) {
      this.tickRow.style.cssText =
        'position:relative;height:16px;font-size:10px;color:#8b949e;margin-top:2px;';

      // Unit label pinned to the left
      const uSpan = document.createElement('span');
      uSpan.textContent = unit;
      uSpan.style.cssText =
        'position:absolute;left:0;top:0;color:#7ee787;font-weight:500;';
      this.tickRow.appendChild(uSpan);

      const range = dataMax - dataMin;

      for (let i = 0; i < ticks.length; i++) {
        const tick = ticks[i]!;
        const pct = range > 0 ? ((tick.value - dataMin) / range) * 100 : 0;
        const span = document.createElement('span');
        span.textContent = tick.label;
        span.style.position = 'absolute';
        span.style.top = '0';

        if (i === 0) {
          // First tick: align left edge
          span.style.left = `${pct}%`;
        } else if (i === ticks.length - 1) {
          // Last tick: align right edge
          span.style.right = '0';
        } else {
          // Middle ticks: centre on position
          span.style.left = `${pct}%`;
          span.style.transform = 'translateX(-50%)';
        }
        this.tickRow.appendChild(span);
      }
    } else {
      // Fallback: just min / unit / max
      this.tickRow.style.cssText =
        'display:flex;justify-content:space-between;font-size:10px;color:#8b949e;margin-top:2px;';
      const minSpan = document.createElement('span');
      minSpan.textContent = formatLegendValue(dataMin);
      const maxSpan = document.createElement('span');
      maxSpan.textContent = formatLegendValue(dataMax);
      const uSpan = document.createElement('span');
      uSpan.style.cssText = 'color:#7ee787;';
      uSpan.textContent = unit;
      this.tickRow.append(minSpan, uSpan, maxSpan);
    }
  }

  hide(): void {
    this.container.style.display = 'none';
  }
}

function formatLegendValue(v: number): string {
  if (Math.abs(v) >= 1000) return v.toFixed(0);
  if (Math.abs(v) >= 1) return v.toFixed(1);
  return v.toPrecision(2);
}
