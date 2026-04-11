/**
 * ScalarFieldLayer — renders a single decoded GRIB2 field on top of a
 * MapLibre GL map as a custom WebGL2 layer.
 *
 * Pipeline:
 *   1. `setData(field, grid)` uploads values to an R32F texture and computes
 *      LCC projection constants + the grid's axis-aligned mercator bounding
 *      rectangle on the CPU.
 *   2. `render()` draws a single quad whose vertex positions are in MapLibre
 *      Mercator unit-square coordinates (`[0,1]²`). The vertex shader
 *      transforms those to clip space via the map's camera matrix — the same
 *      pattern used by MapLibre's own custom-layer example. The fragment
 *      shader receives perspective-correct interpolated mercator coordinates
 *      and unprojects each fragment back to lon/lat, forward-projects through
 *      LCC, and samples the grid.
 *
 * This approach avoids the fragile "unproject from clip space via
 * inverse MVP" dance, which breaks under any pitch/perspective.
 */

import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl';
import type { mat4 } from 'gl-matrix';
import type { DecodedField, LambertConformalGrid } from '../../grib2/types.js';
import { buildProgram } from '../gl/program.js';
import {
  createColormapTexture,
  createScalarTexture,
  enableFloatTextureExtensions,
  type FloatTexture,
} from '../gl/texture.js';
import { colormap, type ColormapName } from '../colormaps.js';
import { LCC_GLSL, computeLccUniforms, gridLonLatBounds, lonLatToGridUV, lonLatToMercator, type LccUniforms } from '../projections/lcc.js';

const VS = /* glsl */ `#version 300 es
in  vec2 aMercator;     // [0,1]² Web Mercator unit square
uniform mat4 uMatrix;   // MapLibre camera matrix (mercator → clip)
out vec2 vMercator;
void main() {
  vMercator = aMercator;
  gl_Position = uMatrix * vec4(aMercator, 0.0, 1.0);
}
`;

const FS = /* glsl */ `#version 300 es
precision highp float;
${LCC_GLSL}

uniform sampler2D uField;
uniform sampler2D uLut;
uniform vec2      uValueRange;
uniform float     uOpacity;

in  vec2 vMercator;
out vec4 outColor;

// Unit-square Mercator → lon/lat (radians). Matches MapLibre's convention:
// (0, 0) = top-left (180°W, ~85.05°N); (1, 1) = bottom-right.
vec2 unprojectUnitMercator(vec2 xy) {
  float lon = xy.x * 6.28318530718 - 3.14159265359;
  float y   = 3.14159265359 * (1.0 - 2.0 * xy.y);
  float lat = atan(sinh(y));
  return vec2(lon, lat);
}

void main() {
  vec2 lonLat = unprojectUnitMercator(vMercator);
  vec2 uv = lccToGrid(lonLat);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;

  float v = texture(uField, uv).r;
  if (isnan(v)) discard;

  float t = (v - uValueRange.x) / max(1e-8, uValueRange.y - uValueRange.x);
  t = clamp(t, 0.0, 1.0);
  vec3 color = texture(uLut, vec2(t, 0.5)).rgb;
  outColor = vec4(color, uOpacity);
}
`;

export interface ScalarFieldLayerOptions {
  id?: string;
  colormap?: ColormapName;
  opacity?: number;
  /** Explicit value range. Defaults to the field's (min, max). */
  valueRange?: [number, number];
  /**
   * Subdivisions of the mercator bounding quad. Higher means more vertices
   * (perspective-correct interpolation is used, so a 1×1 quad is geometrically
   * exact, but a mesh reduces fragment shader work when zoomed in and avoids
   * any edge-case precision issues on curved LCC grids). Default: 1.
   */
  meshResolution?: number;
}

export class ScalarFieldLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MlMap | null = null;
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vertexBuffer: WebGLBuffer | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private indexCount = 0;

  private fieldTex: FloatTexture | null = null;
  private lutTex: FloatTexture | null = null;
  private lcc: LccUniforms | null = null;

  // Retain the decoded field on the CPU so we can sample it in click
  // handlers without a GPU readback. ~8 MB for HRRR CONUS (1799×1059 × 4 B) —
  // a perfectly acceptable cost for interactive inspection.
  private fieldValues: Float32Array | null = null;
  private fieldNx = 0;
  private fieldNy = 0;

  private valueRange: [number, number] = [0, 1];
  private opacity: number;
  private cmapName: ColormapName;
  private meshRes: number;
  private visible = true;

  constructor(opts: ScalarFieldLayerOptions = {}) {
    this.id = opts.id ?? 'gribwebview-scalar';
    this.opacity = opts.opacity ?? 0.85;
    this.cmapName = opts.colormap ?? 'turbo';
    this.meshRes = Math.max(1, opts.meshResolution ?? 1);
    if (opts.valueRange) this.valueRange = opts.valueRange;
  }

  onAdd(map: MlMap, glAny: WebGL2RenderingContext | WebGLRenderingContext): void {
    const gl = glAny as WebGL2RenderingContext;
    this.map = map;
    this.gl = gl;
    enableFloatTextureExtensions(gl);
    this.program = buildProgram(gl, VS, FS, 'scalarField');

    this.vertexBuffer = gl.createBuffer();
    this.indexBuffer = gl.createBuffer();
    this.vao = gl.createVertexArray();
    this.lutTex = createColormapTexture(gl, colormap(this.cmapName));
  }

  /**
   * Upload a new decoded field, compute the grid's mercator bounding
   * rectangle, and build a tessellated mesh covering it. Called again
   * whenever the field changes so we can re-bound the grid (e.g. if
   * switching between HRRR and a different model's grid).
   */
  setData(field: DecodedField, grid: LambertConformalGrid): void {
    if (!this.gl || !this.program) throw new Error('ScalarFieldLayer.setData called before onAdd');
    const gl = this.gl;

    if (this.fieldTex) gl.deleteTexture(this.fieldTex.tex);
    this.fieldTex = createScalarTexture(gl, field.nx, field.ny, field.values);
    this.lcc = computeLccUniforms(grid);
    this.valueRange = [field.min, field.max];
    this.fieldValues = field.values;
    this.fieldNx = field.nx;
    this.fieldNy = field.ny;

    // Compute the mercator rectangle that contains the whole LCC grid.
    // We sample the perimeter of the grid in lon/lat and take the
    // bounding box of the resulting mercator coordinates.
    const bounds = gridLonLatBounds(this.lcc, 64);
    const mercMin = lonLatToMercator(bounds.lonMin, bounds.latMax); // top-left (low y)
    const mercMax = lonLatToMercator(bounds.lonMax, bounds.latMin); // bottom-right (high y)

    // Build a mesh of vertices in mercator coords, with an indexed triangle
    // list. Even a 1×1 mesh is geometrically correct (perspective-correct
    // interpolation handles the inside), but a finer mesh lets us clip more
    // tightly in the vertex shader and helps with zoomed-in rendering.
    const N = this.meshRes;
    const verts = new Float32Array((N + 1) * (N + 1) * 2);
    for (let j = 0; j <= N; j++) {
      for (let i = 0; i <= N; i++) {
        const tx = i / N;
        const ty = j / N;
        verts[(j * (N + 1) + i) * 2 + 0] = mercMin.x + (mercMax.x - mercMin.x) * tx;
        verts[(j * (N + 1) + i) * 2 + 1] = mercMin.y + (mercMax.y - mercMin.y) * ty;
      }
    }
    const indices = new Uint16Array(N * N * 6);
    let k = 0;
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const a = j * (N + 1) + i;
        const b = a + 1;
        const c = a + (N + 1);
        const d = c + 1;
        indices[k++] = a; indices[k++] = b; indices[k++] = c;
        indices[k++] = b; indices[k++] = d; indices[k++] = c;
      }
    }
    this.indexCount = indices.length;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.DYNAMIC_DRAW);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    const loc = gl.getAttribLocation(this.program, 'aMercator');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indexBuffer);
    gl.bindVertexArray(null);

    this.map?.triggerRepaint();
  }

  setColormap(name: ColormapName): void {
    this.cmapName = name;
    if (this.gl && this.lutTex) {
      this.gl.deleteTexture(this.lutTex.tex);
      this.lutTex = createColormapTexture(this.gl, colormap(name));
      this.map?.triggerRepaint();
    }
  }

  setOpacity(op: number): void { this.opacity = op; this.map?.triggerRepaint(); }
  setValueRange(range: [number, number]): void { this.valueRange = range; this.map?.triggerRepaint(); }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }
  isVisible(): boolean { return this.visible; }

  /**
   * Bilinearly sample the field at a geographic point. Returns null if the
   * point is outside the grid or if no data has been loaded yet. The
   * `missing` component indicates how many of the 4 corner samples were NaN
   * — useful for callers that want to reject partial reads on grid edges.
   */
  sampleAt(lonDeg: number, latDeg: number): { value: number; i: number; j: number; missing: number } | null {
    if (!this.fieldValues || !this.lcc) return null;
    const { u, v } = lonLatToGridUV(this.lcc, lonDeg, latDeg);
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    const nx = this.fieldNx, ny = this.fieldNy;
    const fx = u * (nx - 1);
    const fy = v * (ny - 1);
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(nx - 1, i0 + 1);
    const j1 = Math.min(ny - 1, j0 + 1);
    const tx = fx - i0;
    const ty = fy - j0;

    const v00 = this.fieldValues[j0 * nx + i0]!;
    const v10 = this.fieldValues[j0 * nx + i1]!;
    const v01 = this.fieldValues[j1 * nx + i0]!;
    const v11 = this.fieldValues[j1 * nx + i1]!;
    let missing = 0;
    if (Number.isNaN(v00)) missing++;
    if (Number.isNaN(v10)) missing++;
    if (Number.isNaN(v01)) missing++;
    if (Number.isNaN(v11)) missing++;

    // If any corner is missing, fall back to nearest-present; if all are
    // missing, return the nearest (likely NaN) and let the caller decide.
    if (missing === 0) {
      const top = v00 * (1 - tx) + v10 * tx;
      const bot = v01 * (1 - tx) + v11 * tx;
      return { value: top * (1 - ty) + bot * ty, i: Math.round(fx), j: Math.round(fy), missing };
    }
    const nearest = this.fieldValues[Math.round(fy) * nx + Math.round(fx)]!;
    return { value: nearest, i: Math.round(fx), j: Math.round(fy), missing };
  }

  render(glAny: WebGL2RenderingContext | WebGLRenderingContext, matrix: mat4): void {
    const gl = glAny as WebGL2RenderingContext;
    if (!this.visible) return;
    if (!this.program || !this.fieldTex || !this.lutTex || !this.lcc || !this.indexCount) return;

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex.tex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uField'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex.tex);
    gl.uniform1i(gl.getUniformLocation(this.program, 'uLut'), 1);

    gl.uniformMatrix4fv(gl.getUniformLocation(this.program, 'uMatrix'), false, matrix as Float32Array);
    gl.uniform2f(gl.getUniformLocation(this.program, 'uValueRange'), this.valueRange[0], this.valueRange[1]);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uOpacity'), this.opacity);

    const u = this.lcc;
    gl.uniform1f(gl.getUniformLocation(this.program, 'uLccN'), u.n);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uLccF'), u.F);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uLccRho0'), u.rho0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uLccLambda0'), u.lambda0);
    gl.uniform1f(gl.getUniformLocation(this.program, 'uLccRadius'), u.radius);
    gl.uniform2f(gl.getUniformLocation(this.program, 'uLccOrigin'), u.originX, u.originY);
    gl.uniform2f(gl.getUniformLocation(this.program, 'uLccStep'), u.dx, u.dy);
    gl.uniform2f(gl.getUniformLocation(this.program, 'uLccGridSize'), u.nx, u.ny);
    gl.uniform2f(gl.getUniformLocation(this.program, 'uLccScan'), u.scanX, u.scanY);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawElements(gl.TRIANGLES, this.indexCount, gl.UNSIGNED_SHORT, 0);
    gl.bindVertexArray(null);
  }

  onRemove(_map: MlMap, glAny: WebGL2RenderingContext | WebGLRenderingContext): void {
    const gl = glAny as WebGL2RenderingContext;
    if (this.fieldTex) gl.deleteTexture(this.fieldTex.tex);
    if (this.lutTex) gl.deleteTexture(this.lutTex.tex);
    if (this.vertexBuffer) gl.deleteBuffer(this.vertexBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    if (this.vao) gl.deleteVertexArray(this.vao);
    if (this.program) gl.deleteProgram(this.program);
  }
}
