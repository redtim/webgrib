/**
 * WaterMask — a high-resolution shoreline polygon used to clip OFS current
 * layers to open water.
 *
 * Source: `public/shoreline/sfbay-water.geojson`, built by
 * `scripts/build-shoreline.py` from NCEI CUDEM 1/9 arc-second (~3 m)
 * topobathy tiles. One MultiPolygon of "water" in lon/lat.
 *
 * Two consumers, both in screen space so the mask is exact at any zoom:
 *
 *   - `WaterMaskGL` (used by ScalarFieldLayer) triangulates the polygon once
 *     into Web Mercator offsets and, each frame, renders it into an offscreen
 *     R8 texture the size of the drawing buffer. The scalar fragment shader
 *     multiplies alpha by a 3×3 box average of that texture, giving a crisp,
 *     lightly antialiased coastline.
 *
 *   - `rasterizeScreen()` (used by WindyLayer) fills the same polygon into a
 *     2D canvas via the map's own `project()`, producing a Uint8 lookup the
 *     particle engine uses to refuse to seed or step particles on land.
 *
 * Float precision: Mercator unit-square coordinates in float32 are only good
 * to ~1 m at SF Bay latitudes, which is on the order of the source data.
 * Vertices are therefore stored as float32 offsets from a float64 origin and
 * the origin is folded into the camera matrix on the CPU in double precision.
 */

import type { mat4 } from 'gl-matrix';
import earcut from 'earcut';
import { buildProgram } from '../gl/program.js';
import { lonLatToMercator } from '../projections/lcc.js';

type Ring = number[][];          // [[lon, lat], ...]
type PolygonCoords = Ring[];     // [exterior, hole, hole, ...]

interface RingInfo {
  ring: Ring;
  /** Radial-distance decimated copy for zoomed-out canvas fills. */
  coarse: Ring;
  bbox: [number, number, number, number]; // lonMin, latMin, lonMax, latMax
}

interface PolygonInfo {
  rings: RingInfo[];
  bbox: [number, number, number, number];
}

/** Coarse-LOD decimation tolerance in degrees (~20 m). */
const COARSE_TOL_DEG = 20 / 111_000;
/** Below this zoom the particle rasterizer uses the coarse rings. */
const COARSE_MAX_ZOOM = 13;

export class WaterMask {
  readonly polygons: PolygonInfo[];
  readonly bbox: [number, number, number, number];
  readonly vertexCount: number;

  private constructor(polygons: PolygonCoords[]) {
    this.polygons = polygons.map((rings) => {
      const infos = rings.map((ring) => ({ ring, coarse: decimate(ring, COARSE_TOL_DEG), bbox: ringBbox(ring) }));
      const bbox = infos[0]?.bbox ?? [0, 0, 0, 0];
      return { rings: infos, bbox: [...bbox] as [number, number, number, number] };
    });
    this.bbox = this.polygons.reduce<[number, number, number, number]>(
      (b, p) => [Math.min(b[0], p.bbox[0]), Math.min(b[1], p.bbox[1]), Math.max(b[2], p.bbox[2]), Math.max(b[3], p.bbox[3])],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
    this.vertexCount = polygons.reduce((n, rings) => n + rings.reduce((m, r) => m + r.length, 0), 0);
  }

  /** Fetch and parse a GeoJSON Feature/FeatureCollection of (Multi)Polygons. */
  static async load(url: string): Promise<WaterMask> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`water mask fetch failed: ${resp.status} ${resp.statusText}`);
    return WaterMask.fromGeoJSON(await resp.json());
  }

  static fromGeoJSON(json: unknown): WaterMask {
    const polygons: PolygonCoords[] = [];
    const visit = (g: unknown): void => {
      if (!g || typeof g !== 'object') return;
      const o = g as { type?: string; coordinates?: unknown; geometry?: unknown; features?: unknown[] };
      switch (o.type) {
        case 'FeatureCollection': (o.features ?? []).forEach(visit); break;
        case 'Feature': visit(o.geometry); break;
        case 'Polygon': polygons.push(o.coordinates as PolygonCoords); break;
        case 'MultiPolygon': (o.coordinates as PolygonCoords[]).forEach((p) => polygons.push(p)); break;
        default: break;
      }
    };
    visit(json);
    if (polygons.length === 0) throw new Error('water mask GeoJSON contains no polygons');
    return new WaterMask(polygons);
  }

  /**
   * Rasterize the mask in screen space. Returns one byte per CSS pixel
   * (255 = water) plus the dimensions, or null if the viewport doesn't touch
   * the mask at all (caller should treat everything as unmasked).
   */
  rasterizeScreen(
    project: (lon: number, lat: number) => [number, number],
    width: number,
    height: number,
    extent: { west: number; south: number; east: number; north: number },
    zoom: number,
  ): Uint8Array | null {
    if (!boxesIntersect(this.bbox, [extent.west, extent.south, extent.east, extent.north])) return null;

    const canvas = typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(width, height)
      : Object.assign(document.createElement('canvas'), { width, height });
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D | null;
    if (!ctx) return null;

    const view: [number, number, number, number] = [extent.west, extent.south, extent.east, extent.north];
    const useCoarse = zoom < COARSE_MAX_ZOOM;
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    for (const poly of this.polygons) {
      if (!boxesIntersect(poly.bbox, view)) continue;
      for (const r of poly.rings) {
        // Holes fully outside the view can be skipped; the exterior cannot.
        if (r !== poly.rings[0] && !boxesIntersect(r.bbox, view)) continue;
        const ring = useCoarse ? r.coarse : r.ring;
        for (let i = 0; i < ring.length; i++) {
          const [x, y] = project(ring[i]![0]!, ring[i]![1]!);
          if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.closePath();
      }
    }
    ctx.fill('evenodd');
    const img = ctx.getImageData(0, 0, width, height).data;
    const out = new Uint8Array(width * height);
    for (let i = 0, j = 3; i < out.length; i++, j += 4) out[i] = img[j]!;
    return out;
  }
}

// ---------------------------------------------------------------------------
// GL side
// ---------------------------------------------------------------------------

const MASK_VS = /* glsl */ `#version 300 es
in  vec2 aOffset;       // mercator offset from uOrigin (folded into uMatrix)
uniform mat4 uMatrix;
void main() { gl_Position = uMatrix * vec4(aOffset, 0.0, 1.0); }
`;
const MASK_FS = /* glsl */ `#version 300 es
precision mediump float;
out vec4 outColor;
void main() { outColor = vec4(1.0); }
`;

/**
 * GLSL helper for consumers: samples the screen-space mask with a 3×3 box
 * filter. Declare `uniform sampler2D uMask; uniform int uUseMask;` and call
 * `waterMaskAlpha()` from the fragment shader.
 */
export const WATER_MASK_GLSL = /* glsl */ `
uniform sampler2D uMask;
uniform int       uUseMask;
float waterMaskAlpha() {
  if (uUseMask == 0) return 1.0;
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 sz = textureSize(uMask, 0) - ivec2(1);
  float a = 0.0;
  for (int dy = -1; dy <= 1; dy++) {
    for (int dx = -1; dx <= 1; dx++) {
      a += texelFetch(uMask, clamp(p + ivec2(dx, dy), ivec2(0), sz), 0).r;
    }
  }
  return a / 9.0;
}
`;

export class WaterMaskGL {
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private vbo: WebGLBuffer | null = null;
  private ibo: WebGLBuffer | null = null;
  private indexCount = 0;
  private origin: [number, number] = [0, 0];

  private fbo: WebGLFramebuffer | null = null;
  private tex: WebGLTexture | null = null;
  private texW = 0;
  private texH = 0;

  constructor(private readonly gl: WebGL2RenderingContext, mask: WaterMask) {
    const gl2 = gl;
    this.program = buildProgram(gl2, MASK_VS, MASK_FS, 'waterMask');

    // Triangulate in float64 mercator relative to the mask's centre.
    const c = lonLatToMercator((mask.bbox[0] + mask.bbox[2]) / 2, (mask.bbox[1] + mask.bbox[3]) / 2);
    this.origin = [c.x, c.y];

    const verts: number[] = [];
    const indices: number[] = [];
    for (const poly of mask.polygons) {
      const flat: number[] = [];
      const holes: number[] = [];
      for (let r = 0; r < poly.rings.length; r++) {
        const ring = poly.rings[r]!.ring;
        if (r > 0) holes.push(flat.length / 2);
        // GeoJSON rings repeat the first vertex; earcut wants them open.
        const n = ring.length > 1 && sameVertex(ring[0]!, ring[ring.length - 1]!) ? ring.length - 1 : ring.length;
        for (let i = 0; i < n; i++) {
          const m = lonLatToMercator(ring[i]![0]!, ring[i]![1]!);
          flat.push(m.x - c.x, m.y - c.y);
        }
      }
      const base = verts.length / 2;
      const tri = earcut(flat, holes.length ? holes : undefined, 2);
      for (let i = 0; i < tri.length; i++) indices.push(base + tri[i]!);
      for (let i = 0; i < flat.length; i++) verts.push(flat[i]!);
    }
    this.indexCount = indices.length;

    this.vbo = gl2.createBuffer();
    this.ibo = gl2.createBuffer();
    this.vao = gl2.createVertexArray();
    gl2.bindVertexArray(this.vao);
    gl2.bindBuffer(gl2.ARRAY_BUFFER, this.vbo);
    gl2.bufferData(gl2.ARRAY_BUFFER, new Float32Array(verts), gl2.STATIC_DRAW);
    const loc = gl2.getAttribLocation(this.program, 'aOffset');
    gl2.enableVertexAttribArray(loc);
    gl2.vertexAttribPointer(loc, 2, gl2.FLOAT, false, 0, 0);
    gl2.bindBuffer(gl2.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl2.bufferData(gl2.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl2.STATIC_DRAW);
    gl2.bindVertexArray(null);
    gl2.bindBuffer(gl2.ARRAY_BUFFER, null);
    gl2.bindBuffer(gl2.ELEMENT_ARRAY_BUFFER, null);
  }

  /**
   * Render the mask for the current camera into the offscreen texture and
   * return it. Saves and restores every piece of GL state it touches so the
   * caller's draw (and MapLibre's) proceed unaffected.
   */
  render(matrix: mat4): WebGLTexture | null {
    const gl = this.gl;
    if (!this.program || !this.vao || !this.indexCount) return null;

    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    this.ensureTarget(w, h);

    // Fold the origin translation into the matrix in double precision:
    // M' = M · T(origin)  ⇒  column 3 += ox·col0 + oy·col1.
    const m = Array.from(matrix as ArrayLike<number>);
    const [ox, oy] = this.origin;
    for (let r = 0; r < 4; r++) m[12 + r] = m[12 + r]! + ox * m[r]! + oy * m[4 + r]!;

    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const prevViewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const prevBlend = gl.isEnabled(gl.BLEND);
    const prevDepth = gl.isEnabled(gl.DEPTH_TEST);
    const prevStencil = gl.isEnabled(gl.STENCIL_TEST);
    const prevCull = gl.isEnabled(gl.CULL_FACE);
    const prevScissor = gl.isEnabled(gl.SCISSOR_TEST);
    const prevClear = gl.getParameter(gl.COLOR_CLEAR_VALUE) as Float32Array;
    const prevMask = gl.getParameter(gl.COLOR_WRITEMASK) as boolean[];

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, w, h);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.colorMask(true, true, true, true);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'uMatrix'), false, new Float32Array(m));
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_INT, 0);
    gl.bindVertexArray(null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    gl.viewport(prevViewport[0]!, prevViewport[1]!, prevViewport[2]!, prevViewport[3]!);
    if (prevBlend) gl.enable(gl.BLEND);
    if (prevDepth) gl.enable(gl.DEPTH_TEST);
    if (prevStencil) gl.enable(gl.STENCIL_TEST);
    if (prevCull) gl.enable(gl.CULL_FACE);
    if (prevScissor) gl.enable(gl.SCISSOR_TEST);
    gl.clearColor(prevClear[0]!, prevClear[1]!, prevClear[2]!, prevClear[3]!);
    gl.colorMask(prevMask[0]!, prevMask[1]!, prevMask[2]!, prevMask[3]!);
    return this.tex;
  }

  dispose(): void {
    const gl = this.gl;
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.ibo) gl.deleteBuffer(this.ibo);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
    this.fbo = null; this.tex = null; this.vbo = null; this.ibo = null; this.vao = null; this.program = null;
  }

  private ensureTarget(w: number, h: number): void {
    const gl = this.gl;
    if (this.tex && this.texW === w && this.texH === h) return;
    if (this.tex) gl.deleteTexture(this.tex);
    if (!this.fbo) this.fbo = gl.createFramebuffer();
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    const prevFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, prevFbo);
    this.texW = w;
    this.texH = h;
  }
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function ringBbox(ring: Ring): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring as [number, number][]) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

function boxesIntersect(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function sameVertex(a: number[], b: number[]): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/** Radial-distance decimation: drop vertices closer than `tol` to the last kept one. */
function decimate(ring: Ring, tol: number): Ring {
  if (ring.length <= 4) return ring;
  const out: Ring = [ring[0]!];
  let last = ring[0]!;
  for (let i = 1; i < ring.length - 1; i++) {
    const p = ring[i]!;
    if (Math.abs(p[0]! - last[0]!) + Math.abs(p[1]! - last[1]!) >= tol) { out.push(p); last = p; }
  }
  out.push(ring[ring.length - 1]!);
  return out.length >= 4 ? out : ring;
}
