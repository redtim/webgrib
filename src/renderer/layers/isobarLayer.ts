/**
 * IsobarLayer — DOM canvas overlay that draws MSLP isobar contour lines
 * on top of the map, similar to WindyLayer's approach.
 *
 * Uses marching squares to extract isobar polylines at fixed intervals
 * (default 4 hPa), then draws them as labeled contour lines on a canvas
 * overlay synced to the MapLibre viewport.
 */

import type { Map as MlMap } from 'maplibre-gl';

export interface IsobarLayerOptions {
  /** Isobar interval in Pa. Default 400 (= 4 hPa). */
  interval?: number;
  /** Line color. Default 'rgba(255,255,255,0.7)'. */
  lineColor?: string;
  /** Line width in CSS px. Default 1.2. */
  lineWidth?: number;
  /** Label font size in px. Default 10. */
  labelSize?: number;
  /** Label color. Default 'rgba(255,255,255,0.9)'. */
  labelColor?: string;
}

interface IsobarData {
  values: Float32Array;
  nx: number;
  ny: number;
  bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number };
}

interface ContourLine {
  hPa: number;
  segments: Array<[number, number][]>;
}

export class IsobarLayer {
  private map: MlMap | null = null;
  private readonly canvas: HTMLCanvasElement;
  private visible = false;
  private data: IsobarData | null = null;
  private contours: ContourLine[] = [];
  private redrawTimer: number | null = null;

  private readonly interval: number;
  private readonly lineColor: string;
  private readonly lineWidth: number;
  private readonly labelSize: number;
  private readonly labelColor: string;

  constructor(opts: IsobarLayerOptions = {}) {
    this.interval = opts.interval ?? 400;
    this.lineColor = opts.lineColor ?? 'rgba(255,255,255,0.7)';
    this.lineWidth = opts.lineWidth ?? 1.2;
    this.labelSize = opts.labelSize ?? 10;
    this.labelColor = opts.labelColor ?? 'rgba(255,255,255,0.9)';

    this.canvas = document.createElement('canvas');
    const s = this.canvas.style;
    s.position = 'absolute';
    s.top = '0';
    s.left = '0';
    s.width = '100%';
    s.height = '100%';
    s.pointerEvents = 'none';
    s.display = 'none';
  }

  attach(map: MlMap): void {
    if (this.map) return;
    this.map = map;
    map.getCanvasContainer().appendChild(this.canvas);
    this.syncCanvasSize();

    map.on('resize', this.onResize);
    map.on('moveend', this.onMoveEnd);
    map.on('zoomend', this.onMoveEnd);
    map.on('movestart', this.onMoveStart);

    if (this.visible && this.data) this.draw();
  }

  detach(): void {
    if (!this.map) return;
    this.map.off('resize', this.onResize);
    this.map.off('moveend', this.onMoveEnd);
    this.map.off('zoomend', this.onMoveEnd);
    this.map.off('movestart', this.onMoveStart);
    if (this.canvas.parentElement) this.canvas.parentElement.removeChild(this.canvas);
    this.map = null;
  }

  isAttached(): boolean { return this.map !== null; }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.canvas.style.display = visible ? '' : 'none';
    if (visible && this.map && this.data) this.draw();
    if (!visible) this.clearCanvas();
  }

  isVisible(): boolean { return this.visible; }

  setData(
    values: Float32Array,
    nx: number,
    ny: number,
    bounds: { lonMin: number; lonMax: number; latMin: number; latMax: number },
  ): void {
    this.data = { values, nx, ny, bounds };
    this.contours = this.computeContours();
    if (this.map && this.visible) this.draw();
  }

  // ---- contouring (marching squares) ----------------------------------------

  private computeContours(): ContourLine[] {
    if (!this.data) return [];
    const { values, nx, ny } = this.data;

    // Determine contour levels from data range
    let vMin = Infinity, vMax = -Infinity;
    for (let i = 0; i < values.length; i++) {
      const v = values[i]!;
      if (Number.isFinite(v)) {
        if (v < vMin) vMin = v;
        if (v > vMax) vMax = v;
      }
    }

    const interval = this.interval;
    const startLevel = Math.ceil(vMin / interval) * interval;
    const endLevel = Math.floor(vMax / interval) * interval;

    const contours: ContourLine[] = [];

    for (let level = startLevel; level <= endLevel; level += interval) {
      const segments: Array<[number, number][]> = [];

      // Marching squares on each grid cell
      for (let j = 0; j < ny - 1; j++) {
        for (let i = 0; i < nx - 1; i++) {
          const v00 = values[j * nx + i]!;
          const v10 = values[j * nx + i + 1]!;
          const v01 = values[(j + 1) * nx + i]!;
          const v11 = values[(j + 1) * nx + i + 1]!;

          if (!Number.isFinite(v00) || !Number.isFinite(v10) ||
              !Number.isFinite(v01) || !Number.isFinite(v11)) continue;

          // Cell classification (bit 0 = bottom-left, bit 1 = bottom-right,
          // bit 2 = top-right, bit 3 = top-left)
          let code = 0;
          if (v00 >= level) code |= 1;
          if (v10 >= level) code |= 2;
          if (v11 >= level) code |= 4;
          if (v01 >= level) code |= 8;

          if (code === 0 || code === 15) continue;

          // Interpolation helpers — return position in grid coordinates
          const lerp = (va: number, vb: number): number => {
            const d = vb - va;
            return d === 0 ? 0.5 : (level - va) / d;
          };

          // Edge midpoints in grid coords (i, j)
          const bottom: [number, number] = [i + lerp(v00, v10), j];
          const right: [number, number] = [i + 1, j + lerp(v10, v11)];
          const top: [number, number] = [i + lerp(v01, v11), j + 1];
          const left: [number, number] = [i, j + lerp(v00, v01)];

          // Look up line segments for this marching squares case
          const addSeg = (a: [number, number], b: [number, number]) => {
            segments.push([a, b]);
          };

          switch (code) {
            case 1: case 14: addSeg(bottom, left); break;
            case 2: case 13: addSeg(bottom, right); break;
            case 3: case 12: addSeg(left, right); break;
            case 4: case 11: addSeg(right, top); break;
            case 5: // saddle
              addSeg(bottom, right);
              addSeg(left, top);
              break;
            case 6: case 9: addSeg(bottom, top); break;
            case 7: case 8: addSeg(left, top); break;
            case 10: // saddle
              addSeg(bottom, left);
              addSeg(right, top);
              break;
          }
        }
      }

      if (segments.length > 0) {
        contours.push({ hPa: Math.round(level / 100), segments });
      }
    }

    return contours;
  }

  // ---- rendering ------------------------------------------------------------

  private draw(): void {
    if (!this.map || !this.data || this.contours.length === 0) return;
    this.syncCanvasSize();
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;

    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    const map = this.map;
    const { nx, ny, bounds } = this.data;

    // Convert grid (i,j) to screen (x,y)
    const toScreen = (gridI: number, gridJ: number): { x: number; y: number } | null => {
      const lon = bounds.lonMin + (gridI / (nx - 1)) * (bounds.lonMax - bounds.lonMin);
      const lat = bounds.latMin + (gridJ / (ny - 1)) * (bounds.latMax - bounds.latMin);
      const p = map.project([lon, lat]);
      return { x: p.x, y: p.y };
    };

    ctx.lineWidth = this.lineWidth;
    ctx.strokeStyle = this.lineColor;
    ctx.lineJoin = 'round';

    for (const contour of this.contours) {
      // Draw all segments for this contour level
      ctx.beginPath();
      for (const seg of contour.segments) {
        const p0 = toScreen(seg[0]![0], seg[0]![1]);
        const p1 = toScreen(seg[1]![0], seg[1]![1]);
        if (!p0 || !p1) continue;
        ctx.moveTo(p0.x, p0.y);
        ctx.lineTo(p1.x, p1.y);
      }
      ctx.stroke();

      // Place labels at intervals along contour segments
      this.drawLabels(ctx, contour, toScreen);
    }
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    contour: ContourLine,
    toScreen: (i: number, j: number) => { x: number; y: number } | null,
  ): void {
    ctx.font = `bold ${this.labelSize}px sans-serif`;
    ctx.fillStyle = this.labelColor;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    const label = String(contour.hPa);
    const w = this.canvas.width;
    const h = this.canvas.height;

    // Place a label roughly every 150px along the contour
    const SPACING = 150;
    let distSinceLabel = SPACING * 0.5; // start offset to stagger labels

    for (const seg of contour.segments) {
      const p0 = toScreen(seg[0]![0], seg[0]![1]);
      const p1 = toScreen(seg[1]![0], seg[1]![1]);
      if (!p0 || !p1) continue;

      // Skip segments fully off screen
      if ((p0.x < -20 && p1.x < -20) || (p0.x > w + 20 && p1.x > w + 20)) continue;
      if ((p0.y < -20 && p1.y < -20) || (p0.y > h + 20 && p1.y > h + 20)) continue;

      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const segLen = Math.hypot(dx, dy);
      distSinceLabel += segLen;

      if (distSinceLabel >= SPACING && segLen > 2) {
        const mx = (p0.x + p1.x) / 2;
        const my = (p0.y + p1.y) / 2;
        // Only label if on screen
        if (mx > 10 && mx < w - 10 && my > 10 && my < h - 10) {
          // Halo effect
          ctx.strokeStyle = 'rgba(0,0,0,0.6)';
          ctx.lineWidth = 3;
          ctx.strokeText(label, mx, my);
          ctx.fillText(label, mx, my);
          distSinceLabel = 0;
        }
      }
    }

    // Restore stroke style for contour lines
    ctx.strokeStyle = this.lineColor;
    ctx.lineWidth = this.lineWidth;
  }

  // ---- sync -----------------------------------------------------------------

  private syncCanvasSize(): void {
    if (!this.map) return;
    const container = this.map.getContainer();
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private clearCanvas(): void {
    const ctx = this.canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private scheduleRedraw(delayMs = 100): void {
    if (this.redrawTimer !== null) clearTimeout(this.redrawTimer);
    this.redrawTimer = window.setTimeout(() => {
      this.redrawTimer = null;
      if (this.map && this.visible && this.data) this.draw();
    }, delayMs);
  }

  private onResize = (): void => {
    this.clearCanvas();
    this.syncCanvasSize();
    this.scheduleRedraw();
  };

  private onMoveStart = (): void => {
    this.clearCanvas();
  };

  private onMoveEnd = (): void => {
    this.scheduleRedraw();
  };
}
