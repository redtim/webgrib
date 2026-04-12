/**
 * Colorbar / legend component. Renders a horizontal gradient bar with
 * min/max labels and a unit string. Updates when the active layer changes.
 */
import { colormap } from '../renderer/colormaps.js';
export class Legend {
    container;
    canvas;
    minLabel;
    maxLabel;
    unitLabel;
    constructor(parent) {
        this.container = document.createElement('div');
        this.container.className = 'legend';
        this.container.style.cssText = 'margin-top:8px;display:none;';
        this.canvas = document.createElement('canvas');
        this.canvas.width = 256;
        this.canvas.height = 12;
        this.canvas.style.cssText = 'width:100%;height:12px;border-radius:2px;';
        const labels = document.createElement('div');
        labels.style.cssText = 'display:flex;justify-content:space-between;font-size:10px;color:#8b949e;margin-top:2px;';
        this.minLabel = document.createElement('span');
        this.maxLabel = document.createElement('span');
        this.unitLabel = document.createElement('span');
        this.unitLabel.style.cssText = 'color:#7ee787;';
        labels.append(this.minLabel, this.unitLabel, this.maxLabel);
        this.container.append(this.canvas, labels);
        parent.appendChild(this.container);
    }
    update(cmap, min, max, unit) {
        this.container.style.display = '';
        const rgba = colormap(cmap);
        const ctx = this.canvas.getContext('2d');
        const img = ctx.createImageData(256, 1);
        img.data.set(rgba);
        ctx.putImageData(img, 0, 0);
        // Scale up to fill canvas height
        ctx.drawImage(this.canvas, 0, 0, 256, 1, 0, 0, 256, 12);
        this.minLabel.textContent = formatLegendValue(min);
        this.maxLabel.textContent = formatLegendValue(max);
        this.unitLabel.textContent = unit;
    }
    hide() {
        this.container.style.display = 'none';
    }
}
function formatLegendValue(v) {
    if (Math.abs(v) >= 1000)
        return v.toFixed(0);
    if (Math.abs(v) >= 1)
        return v.toFixed(1);
    return v.toPrecision(2);
}
