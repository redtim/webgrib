/**
 * WindyLayer — DOM canvas overlay that renders wind-particle streamlines on
 * top of a MapLibre GL map using the vendored leaflet-velocity `windy.js`
 * particle core.
 *
 * Unlike the earlier `WindParticleLayer` (a WebGL2 `CustomLayerInterface`
 * that painted particles into MapLibre's own GL context), this layer lives
 * entirely outside the MapLibre render pipeline. It:
 *
 *   1. Creates its own `<canvas>` element and appends it to the map's
 *      canvas container, stacked above the WebGL basemap.
 *   2. Hands that canvas to `windy.js`, which runs its own `requestAnimation
 *      Frame` loop (defaulting to 15 fps) and draws line-segment trails on
 *      it using plain Canvas2D — the look that leaflet-velocity ships with
 *      and that the user specifically wanted.
 *   3. Synchronizes the canvas with the map viewport: on move/zoom start,
 *      windy is stopped and the canvas is cleared (particles would be
 *      geographically stale otherwise); on move/zoom end the particle
 *      simulation is restarted against the new viewport after a short
 *      debounce.
 *
 * `windy.js` only understands regular lat/lon grids. HRRR data is on a
 * Lambert Conformal Conic grid with grid-relative u/v components, so
 * `setWind` runs the source field through `resampleLccToLatLon` before
 * handing it off. The raw LCC data is retained on the instance so
 * `sampleAt` (click-to-inspect) still reads from the unresampled values and
 * stays identically accurate to the old renderer.
 *
 * Trade-offs vs the old WebGL layer:
 *   - Pro: the visual look matches leaflet-velocity / nullschool — soft
 *     line trails, proper lifecycle fade, bilinear interpolation, tuned
 *     defaults.
 *   - Con: because the canvas is a DOM element rather than a MapLibre
 *     layer, it sits above every basemap layer. Roads and place labels end
 *     up underneath wind trails rather than on top. The demo's basemap
 *     already dims road opacity heavily (`src/demo/main.ts:258`), so this
 *     is cosmetically acceptable.
 *   - Con: during pan/zoom the canvas is cleared (leaflet-velocity's
 *     standard behavior). Particles pop back in once the camera settles.
 */

import type { Map as MlMap } from 'maplibre-gl';
import Windy from './vendor/windy.js';
import type { WindyComponent, WindyInstance } from './vendor/windy.js';
import type { DecodedField, LambertConformalGrid } from '../../grib2/types.js';
import { resampleLccToLatLon } from '../../grib2/resample.js';
import { computeLccUniforms, lonLatToGridUV, type LccUniforms } from '../projections/lcc.js';

export interface WindyLayerOptions {
  id?: string;
  /** CSS opacity applied to the overlay canvas. Default 0.9. */
  opacity?: number;
  /**
   * Minimum wind speed (m/s) that maps to the first entry of the color
   * palette. Slower winds clamp here. Default 0.
   */
  minVelocity?: number;
  /**
   * Maximum wind speed (m/s) that maps to the last entry of the color
   * palette. If omitted, uses the actual observed max from the resampled
   * field so the palette auto-fits the data.
   */
  maxVelocity?: number;
  /** Passed straight through to windy.js — governs per-frame particle advance. */
  velocityScale?: number;
  /** Frames before a particle respawns. */
  particleAge?: number;
  /** Line width (CSS px) for a drawn particle trail. */
  lineWidth?: number;
  /** Particle-count scalar — multiplied against canvas area. */
  particleMultiplier?: number;
  /** Target frame rate for the particle animation. */
  frameRate?: number;
  /** Custom color palette. Array of CSS color strings, low-speed → high-speed. */
  colorScale?: string[];
}

/** Matches the `sampleAt` return shape of the old WindParticleLayer so the
 *  demo's click-to-inspect popup keeps working unchanged. */
export interface WindSample {
  u: number;
  v: number;
  speed: number;
  directionDeg: number;
}

export class WindyLayer {
  readonly id: string;

  private map: MlMap | null = null;
  private readonly canvas: HTMLCanvasElement;
  private windy: WindyInstance | null = null;
  private visible = true;
  private restartTimer: number | null = null;

  // Most recently resampled windy payload + observed max speed.
  private currentData: [WindyComponent, WindyComponent] | null = null;
  private currentMaxSpeed = 0;

  // Original LCC wind field retained for sampleAt (click-to-inspect).
  private uValues: Float32Array | null = null;
  private vValues: Float32Array | null = null;
  private windNx = 0;
  private windNy = 0;
  private lcc: LccUniforms | null = null;

  // Snapshot of user-provided options; we only read them when (re)starting.
  private readonly minVelocity: number;
  private readonly maxVelocityOverride: number | undefined;
  private readonly velocityScale: number;
  private readonly particleAge: number;
  private readonly lineWidth: number;
  private readonly particleMultiplier: number;
  private readonly frameRate: number;
  private readonly colorScale: string[] | undefined;

  constructor(opts: WindyLayerOptions = {}) {
    this.id = opts.id ?? 'gribwebview-wind';
    this.minVelocity = opts.minVelocity ?? 0;
    this.maxVelocityOverride = opts.maxVelocity;
    this.velocityScale = opts.velocityScale ?? 0.005;
    this.particleAge = opts.particleAge ?? 90;
    this.lineWidth = opts.lineWidth ?? 1.2;
    this.particleMultiplier = opts.particleMultiplier ?? 1 / 300;
    this.frameRate = opts.frameRate ?? 15;
    this.colorScale = opts.colorScale;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gribwebview-wind-canvas';
    // Absolute overlay that fills the map container. `pointer-events: none`
    // is critical — the base map still needs to receive pan/zoom input and
    // the demo's click-to-inspect handler has to fire on the underlying map.
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

    map.on('resize', this.onResize);
    map.on('movestart', this.onMoveStart);
    map.on('zoomstart', this.onMoveStart);
    map.on('moveend', this.onMoveEnd);
    map.on('zoomend', this.onMoveEnd);

    if (this.visible && this.currentData) this.start();
  }

  detach(): void {
    if (!this.map) return;
    const map = this.map;
    this.stop();
    map.off('resize', this.onResize);
    map.off('movestart', this.onMoveStart);
    map.off('zoomstart', this.onMoveStart);
    map.off('moveend', this.onMoveEnd);
    map.off('zoomend', this.onMoveEnd);
    if (this.canvas.parentElement) this.canvas.parentElement.removeChild(this.canvas);
    this.map = null;
  }

  isAttached(): boolean {
    return this.map !== null;
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) return;
    this.visible = visible;
    this.canvas.style.display = visible ? '' : 'none';
    if (!visible) {
      this.stop();
    } else if (this.map && this.currentData) {
      this.start();
    }
  }

  isVisible(): boolean {
    return this.visible;
  }

  // ---------------------------------------------------------------- data

  /**
   * Swap in a new wind field. Resamples from the source LCC grid into a
   * regular lat/lon grid (windy.js's only supported format), retains the
   * original source for click-to-inspect sampling, and restarts the
   * animation if the layer is currently attached and visible.
   */
  setWind(u: DecodedField, v: DecodedField, grid: LambertConformalGrid): void {
    if (u.nx !== v.nx || u.ny !== v.ny) {
      throw new Error('u/v grid mismatch');
    }

    // Retain the raw LCC field for sampleAt. We use the unresampled data so
    // the popup readout remains pixel-accurate to the source regardless of
    // the resampler's target resolution.
    this.uValues = u.values;
    this.vValues = v.values;
    this.windNx = u.nx;
    this.windNy = u.ny;
    this.lcc = computeLccUniforms(grid);

    const resampled = resampleLccToLatLon(u, v, grid);
    this.currentData = resampled.components;
    this.currentMaxSpeed = resampled.maxSpeed;

    if (this.map && this.visible) this.start();
  }

  /**
   * Sample the source wind field at a geographic point via bilinear
   * interpolation. Mirrors the old WindParticleLayer.sampleAt signature so
   * the demo's click-to-inspect popup code (`src/demo/main.ts:336`) keeps
   * working unchanged.
   */
  sampleAt(lonDeg: number, latDeg: number): WindSample | null {
    if (!this.uValues || !this.vValues || !this.lcc) return null;
    const { u, v } = lonLatToGridUV(this.lcc, lonDeg, latDeg);
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    const nx = this.windNx;
    const ny = this.windNy;
    const fx = u * (nx - 1);
    const fy = v * (ny - 1);
    const i0 = Math.floor(fx);
    const j0 = Math.floor(fy);
    const i1 = Math.min(nx - 1, i0 + 1);
    const j1 = Math.min(ny - 1, j0 + 1);
    const tx = fx - i0;
    const ty = fy - j0;
    const bilin = (arr: Float32Array): number => {
      const a00 = arr[j0 * nx + i0]!;
      const a10 = arr[j0 * nx + i1]!;
      const a01 = arr[j1 * nx + i0]!;
      const a11 = arr[j1 * nx + i1]!;
      const top = a00 * (1 - tx) + a10 * tx;
      const bot = a01 * (1 - tx) + a11 * tx;
      return top * (1 - ty) + bot * ty;
    };
    const uu = bilin(this.uValues);
    const vv = bilin(this.vValues);
    const speed = Math.hypot(uu, vv);
    // Meteorological convention: direction wind is coming FROM, 0° = N, CW.
    let dir = (Math.atan2(-uu, -vv) * 180) / Math.PI;
    if (dir < 0) dir += 360;
    return { u: uu, v: vv, speed, directionDeg: dir };
  }

  // ---------------------------------------------------------------- internals

  private syncCanvasSize(): void {
    if (!this.map) return;
    const container = this.map.getContainer();
    const w = Math.max(1, container.clientWidth);
    const h = Math.max(1, container.clientHeight);
    // Canvas2D performance scales with pixel count, and devicePixelRatio=2
    // quadruples it for marginal visual gain on trails. Keep the backing
    // store at CSS pixels.
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
  }

  private clearCanvas(): void {
    const ctx = this.canvas.getContext('2d');
    if (ctx) ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  private stop(): void {
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.windy) {
      this.windy.stop();
      this.windy = null;
    }
    this.clearCanvas();
  }

  private start(): void {
    if (!this.map || !this.currentData || !this.visible) return;
    this.stop();
    this.syncCanvasSize();

    const map = this.map;
    const width = this.canvas.width;
    const height = this.canvas.height;

    const mb = map.getBounds();
    const extent: [[number, number], [number, number]] = [
      [mb.getWest(), mb.getSouth()],
      [mb.getEast(), mb.getNorth()],
    ];
    const bounds: [[number, number], [number, number]] = [
      [0, 0],
      [width - 1, height - 1],
    ];

    // If the caller didn't pin a maxVelocity, let windy color-scale against
    // the actual observed max so the palette always spans the data.
    const maxV = this.maxVelocityOverride ?? (this.currentMaxSpeed > 0 ? this.currentMaxSpeed : 30);

    this.windy = Windy({
      canvas: this.canvas,
      data: this.currentData,
      // MapLibre's project/unproject take [lng, lat] tuples. The windy
      // signatures, for historical reasons, are `project(lat, lon)` and
      // `invert(x, y) → [lon, lat]`, so we swap arguments here.
      invert: (x: number, y: number): [number, number] => {
        const ll = map.unproject([x, y]);
        return [ll.lng, ll.lat];
      },
      project: (lat: number, lon: number): [number, number] => {
        const p = map.project([lon, lat]);
        return [p.x, p.y];
      },
      minVelocity: this.minVelocity,
      maxVelocity: maxV,
      velocityScale: this.velocityScale,
      particleAge: this.particleAge,
      lineWidth: this.lineWidth,
      particleMultiplier: this.particleMultiplier,
      frameRate: this.frameRate,
      colorScale: this.colorScale,
    });

    this.windy.start(bounds, width, height, extent);
  }

  /** Debounced restart — coalesces multiple zoom/resize events. */
  private scheduleRestart(delayMs = 150): void {
    if (this.restartTimer !== null) clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => {
      this.restartTimer = null;
      if (this.map && this.visible && this.currentData) this.start();
    }, delayMs);
  }

  // Arrow-function fields so they can be used as event handlers without
  // rebinding `this` on every add/remove call.
  private onResize = (): void => {
    this.stop();
    this.syncCanvasSize();
    this.scheduleRestart();
  };

  private onMoveStart = (): void => {
    if (this.windy) {
      this.windy.stop();
      this.windy = null;
    }
    this.clearCanvas();
  };

  private onMoveEnd = (): void => {
    this.scheduleRestart();
  };
}
