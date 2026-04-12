/**
 * LightningLayer — real-time lightning strikes from Blitzortung rendered as
 * animated flash markers on a DOM canvas overlay above the MapLibre map.
 *
 * Connects to the Blitzortung websocket (plain JSON on port 3000), accumulates
 * strikes, and renders them as radial flashes that fade over a configurable
 * max age window. Old strikes are pruned each frame.
 *
 * Like WindyLayer this is a DOM canvas overlay, not a MapLibre custom layer.
 * It creates its own <canvas> and appends it to the map's canvas container.
 */

import type { Map as MlMap } from 'maplibre-gl';

export interface LightningLayerOptions {
  /** Max age in ms before a strike is removed. Default 10 minutes. */
  maxAge?: number;
  /** Initial flash radius in CSS px. Default 6. */
  flashRadius?: number;
  /** Canvas opacity. Default 0.9. */
  opacity?: number;
  /** Websocket server URL. Default wss://ws1.blitzortung.org:3000/ */
  wsUrl?: string;
}

interface Strike {
  lat: number;
  lon: number;
  time: number; // ms since epoch
  pol: number;  // -1 or +1
}

export class LightningLayer {
  private map: MlMap | null = null;
  private readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D | null = null;
  private visible = true;
  private animFrame = 0;

  private ws: WebSocket | null = null;
  private readonly wsUrl: string;
  private reconnectTimer: number | null = null;
  private strikes: Strike[] = [];

  private readonly maxAge: number;
  private readonly flashRadius: number;

  constructor(opts: LightningLayerOptions = {}) {
    this.maxAge = opts.maxAge ?? 10 * 60 * 1000;
    this.flashRadius = opts.flashRadius ?? 6;
    this.wsUrl = opts.wsUrl ?? 'wss://ws1.blitzortung.org/';

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gribwebview-lightning-canvas';
    const s = this.canvas.style;
    s.position = 'absolute';
    s.top = '0';
    s.left = '0';
    s.width = '100%';
    s.height = '100%';
    s.pointerEvents = 'none';
    s.opacity = String(opts.opacity ?? 0.9);
  }

  // ---------------------------------------------------------------- lifecycle

  attach(map: MlMap): void {
    if (this.map) return;
    this.map = map;
    map.getCanvasContainer().appendChild(this.canvas);
    this.syncCanvasSize();
    this.ctx = this.canvas.getContext('2d');

    map.on('resize', this.onResize);
    this.connectWs();
    if (this.visible) this.startRender();
  }

  detach(): void {
    if (!this.map) return;
    this.map.off('resize', this.onResize);
    this.stopRender();
    this.disconnectWs();
    if (this.canvas.parentElement) this.canvas.parentElement.removeChild(this.canvas);
    this.map = null;
    this.ctx = null;
  }

  isAttached(): boolean {
    return this.map !== null;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.canvas.style.display = visible ? '' : 'none';
    if (visible) {
      this.connectWs();
      this.startRender();
    } else {
      this.stopRender();
      this.disconnectWs();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  /** Number of strikes currently held in the buffer. */
  get strikeCount(): number {
    return this.strikes.length;
  }

  // ---------------------------------------------------------------- websocket

  private connectWs(): void {
    if (this.ws) return;
    try {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.onopen = () => {
        this.ws?.send(JSON.stringify({ a: 111 }));
      };
      this.ws.onmessage = (ev) => {
        try {
          const raw = decodeLzw(ev.data as string);
          const d = JSON.parse(raw);
          if (typeof d.lat === 'number' && typeof d.lon === 'number' && typeof d.time === 'number') {
            this.strikes.push({
              lat: d.lat + (d.latc ?? 0),
              lon: d.lon + (d.lonc ?? 0),
              time: d.time / 1e6, // nanoseconds → ms
              pol: d.pol ?? -1,
            });
          }
        } catch { /* ignore malformed */ }
      };
      this.ws.onclose = () => {
        this.ws = null;
        this.scheduleReconnect();
      };
      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this.scheduleReconnect();
    }
  }

  private disconnectWs(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (this.visible && this.map) this.connectWs();
    }, 5000);
  }

  // ---------------------------------------------------------------- rendering

  private startRender(): void {
    if (this.animFrame) return;
    const tick = (): void => {
      this.draw();
      this.animFrame = requestAnimationFrame(tick);
    };
    this.animFrame = requestAnimationFrame(tick);
  }

  private stopRender(): void {
    if (this.animFrame) {
      cancelAnimationFrame(this.animFrame);
      this.animFrame = 0;
    }
    this.clearCanvas();
  }

  private draw(): void {
    const ctx = this.ctx;
    const map = this.map;
    if (!ctx || !map) return;

    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.clearRect(0, 0, w, h);

    const now = Date.now();
    this.strikes = this.strikes.filter((s) => now - s.time < this.maxAge);

    for (const s of this.strikes) {
      const age = now - s.time;
      const t = age / this.maxAge; // 0 = fresh, 1 = expiring

      const pt = map.project([s.lon, s.lat]);
      const x = pt.x;
      const y = pt.y;
      if (x < -20 || x > w + 20 || y < -20 || y > h + 20) continue;

      // Age color scale: white → yellow → orange → red → dark grey
      const color = ageColor(t);
      const alpha = Math.max(0.08, 1 - t * t);

      // Scale: bolts shrink slightly as they age
      const scale = this.flashRadius / 10 * (1 - t * 0.4);

      // Initial flash glow for very new strikes
      if (t < 0.04) {
        const glowR = this.flashRadius * 3 * (1 - t / 0.04);
        const glow = ctx.createRadialGradient(x, y, 0, x, y, glowR);
        glow.addColorStop(0, `rgba(255,255,240,${0.7 * (1 - t / 0.04)})`);
        glow.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = glow;
        ctx.beginPath();
        ctx.arc(x, y, glowR, 0, Math.PI * 2);
        ctx.fill();
      }

      // Draw lightning bolt SVG shape
      ctx.save();
      ctx.translate(x, y);
      ctx.scale(scale, scale);
      ctx.globalAlpha = alpha;
      ctx.fillStyle = color;
      ctx.strokeStyle = `rgba(0,0,0,${alpha * 0.4})`;
      ctx.lineWidth = 0.6 / scale;
      ctx.beginPath();
      // Bolt shape: tip at bottom (0,8), top at (0,-8), zig-zag
      ctx.moveTo(1, -8);
      ctx.lineTo(-2, -1);
      ctx.lineTo(0.5, -1);
      ctx.lineTo(-1.5, 3);
      ctx.lineTo(1, 3);
      ctx.lineTo(-1, 8);
      ctx.lineTo(3, 1);
      ctx.lineTo(0.5, 1);
      ctx.lineTo(3, -3);
      ctx.lineTo(0.5, -3);
      ctx.lineTo(3, -8);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }

  private clearCanvas(): void {
    if (this.ctx) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private syncCanvasSize(): void {
    if (!this.map) return;
    const container = this.map.getContainer();
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private onResize = (): void => {
    this.syncCanvasSize();
  };
}

/**
 * Maps strike age (0 = just arrived, 1 = expiring) to a color string.
 * Gradient: bright white → yellow → orange → red → dark grey.
 */
function ageColor(t: number): string {
  // 5-stop gradient sampled linearly
  const stops: [number, number, number][] = [
    [255, 255, 255], // 0.00 — white
    [255, 240, 80],  // 0.25 — yellow
    [255, 160, 40],  // 0.50 — orange
    [220, 60, 40],   // 0.75 — red
    [90, 90, 100],   // 1.00 — dark grey
  ];
  const idx = Math.min(t, 0.999) * (stops.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.min(lo + 1, stops.length - 1);
  const f = idx - lo;
  const r = Math.round(stops[lo]![0] * (1 - f) + stops[hi]![0] * f);
  const g = Math.round(stops[lo]![1] * (1 - f) + stops[hi]![1] * f);
  const b = Math.round(stops[lo]![2] * (1 - f) + stops[hi]![2] * f);
  return `rgb(${r},${g},${b})`;
}

/** LZW decompressor for Blitzortung's compressed websocket messages. */
function decodeLzw(input: string): string {
  const chars = input.split('');
  const dict: Record<number, string> = {};
  let currChar = chars[0]!;
  let oldPhrase = currChar;
  const out = [currChar];
  let dictSize = 256;
  let o = dictSize;
  for (let i = 1; i < chars.length; i++) {
    const code = chars[i]!.charCodeAt(0);
    let phrase: string;
    if (dictSize > code) {
      phrase = chars[i]!;
    } else {
      phrase = dict[code] ? dict[code]! : oldPhrase + currChar;
    }
    out.push(phrase);
    currChar = phrase.charAt(0);
    dict[o] = oldPhrase + currChar;
    o++;
    oldPhrase = phrase;
  }
  return out.join('');
}
