/**
 * WindParticleLayer — GPU-advected wind streamlines on top of a MapLibre map.
 *
 * Architecture (straight out of the webgl-wind playbook, adapted for WebGL2
 * + MapLibre custom layers):
 *
 *   - Particle state (position = uv in [0, 1] grid space) lives in an RGBA8
 *     texture. R/G pack x, B/A pack y, giving us 16-bit fixed-point precision
 *     per component.
 *
 *   - Every frame we run two passes into a framebuffer:
 *
 *       1) update.fs: sample the UV field at each particle's current
 *          position, step the position forward, handle respawn via a pseudo-
 *          random position when a particle goes stale (for visual variety).
 *          Output → the "next" particle-state texture (ping-pong).
 *
 *       2) draw.fs: render each particle as a GL_POINT, color by speed.
 *          Blend onto a "trails" framebuffer that is also faded each frame
 *          to create streaking tails.
 *
 *   - Finally we draw the trails framebuffer as a fullscreen quad into the
 *     main target, passing the MapLibre MVP for positioning.
 *
 * The trails approach keeps the fragment cost tied to the map viewport, not
 * the particle count, so we can push particle counts into the hundreds of
 * thousands without breaking a sweat.
 */

import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl';
import type { mat4 } from 'gl-matrix';
import type { DecodedField, LambertConformalGrid } from '../../grib2/types.js';
import { buildProgram } from '../gl/program.js';
import {
  createColormapTexture,
  createVectorTexture,
  enableFloatTextureExtensions,
  type FloatTexture,
} from '../gl/texture.js';
import { colormap, type ColormapName } from '../colormaps.js';
import { LCC_GLSL, computeLccUniforms, lonLatToGridUV, type LccUniforms } from '../projections/lcc.js';

// --- Shaders ---------------------------------------------------------------

const QUAD_VS = /* glsl */ `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() {
  vUv = aPos * 0.5 + 0.5;
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

const UPDATE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uParticles; // previous state
uniform sampler2D uWind;      // RG = u, v (m/s, in native grid order)
uniform vec2  uWindRange;     // (minSpeed, maxSpeed) for normalization
uniform float uSpeedFactor;   // steps per frame multiplier
uniform float uDropRate;      // 0..0.1 — chance a particle respawns each frame
uniform float uDropRateBump;  // extra drop rate for fast particles
uniform vec2  uRand;          // uniform random seed per frame

// 16-bit fixed-point packing of a [0, 1] float across two RGBA bytes.
vec2 unpack2(vec4 packed) {
  return vec2(
    packed.r / 255.0 + packed.g,
    packed.b / 255.0 + packed.a
  );
}
vec4 pack2(vec2 v) {
  vec2 lo = fract(v * 255.0);
  vec2 hi = v - lo / 255.0;
  return vec4(lo.x, hi.x, lo.y, hi.y);
}

// From https://thebookofshaders.com — decent one-frame hash.
float rand(vec2 co) {
  return fract(sin(dot(co + uRand, vec2(12.9898, 78.233))) * 43758.5453);
}

void main() {
  vec4 packed = texture(uParticles, vUv);
  vec2 pos = unpack2(packed);

  vec2 uv = texture(uWind, pos).rg;
  float speed = length(uv);
  float normSpeed = clamp(speed / max(1e-6, uWindRange.y), 0.0, 1.0);

  // HRRR LCC grid is ~3 km per cell. Convert m/s step to texture step.
  vec2 step = uv * uSpeedFactor;
  vec2 next = pos + step;

  // Wrap / respawn if we leave the field or randomly retire.
  float drop = uDropRate + uDropRateBump * normSpeed;
  float r = rand(vUv);
  bool out_of_bounds = next.x < 0.0 || next.x > 1.0 || next.y < 0.0 || next.y > 1.0;
  if (out_of_bounds || r < drop) {
    // Respawn at a fresh random point inside the grid.
    next = vec2(rand(vUv + vec2(3.17, 8.93)), rand(vUv + vec2(1.07, 6.11)));
  }

  outColor = pack2(next);
}
`;

const DRAW_VS = /* glsl */ `#version 300 es
precision highp float;
in float aIndex;
uniform sampler2D uParticles;
uniform vec2  uParticleGrid;   // (cols, rows) of particle state texture
uniform mat4  uMvp;            // world→clip
${LCC_GLSL}
out float vSpeed;
uniform sampler2D uWind;
uniform vec2 uWindRange;
uniform vec2 uViewport;

vec2 unpack2(vec4 packed) {
  return vec2(
    packed.r / 255.0 + packed.g,
    packed.b / 255.0 + packed.a
  );
}

// Grid uv → lon/lat radians using the inverse LCC we're about to derive
// client-side. The easier path for the draw step is to keep a second
// sampler of the wind field for read-back and use a precomputed lon/lat
// texture. But that's heavy; here we do the cheap approximation of sampling
// the "uv" grid texture by normalized coord and projecting analytically.
// We treat each particle position as normalized LCC plane meters and undo
// the forward LCC we applied earlier.

// Inverse LCC (spherical):
//   rho = sign(n) * sqrt(x^2 + (rho0 - y)^2)
//   theta = atan2(x, rho0 - y)
//   lat = 2·atan((R·F/rho)^(1/n)) − π/2
//   lon = lambda0 + theta/n
vec2 gridToLonLat(vec2 uv) {
  vec2 m; // meters from grid origin
  m.x = (uLccScan.x > 0.0 ? uv.x : 1.0 - uv.x) * (uLccStep.x * (uLccGridSize.x - 1.0));
  m.y = (uLccScan.y > 0.0 ? uv.y : 1.0 - uv.y) * (uLccStep.y * (uLccGridSize.y - 1.0));
  float x = m.x + uLccOrigin.x;
  float y = m.y + uLccOrigin.y;
  float rho = sign(uLccN) * sqrt(x * x + (uLccRho0 - y) * (uLccRho0 - y));
  float theta = atan(x, uLccRho0 - y);
  float lat = 2.0 * atan(pow(uLccRadius * uLccF / rho, 1.0 / uLccN)) - 1.5707963;
  float lon = uLccLambda0 + theta / uLccN;
  return vec2(lon, lat);
}

vec2 lonLatToWorld(vec2 ll) {
  // Web Mercator unit square: x=(lon+π)/(2π), y=(1 − ln(tan(π/4+lat/2))/π) / 2
  float x = (ll.x + 3.14159265359) / 6.28318530718;
  float y = 0.5 * (1.0 - log(tan(0.78539816 + ll.y * 0.5)) / 3.14159265359);
  return vec2(x, y);
}

void main() {
  float col = mod(aIndex, uParticleGrid.x);
  float row = floor(aIndex / uParticleGrid.x);
  vec2 uv = (vec2(col, row) + 0.5) / uParticleGrid;
  vec2 pos = unpack2(texture(uParticles, uv));

  // Sample wind at this particle to compute a speed for coloring.
  vec2 wind = texture(uWind, pos).rg;
  vSpeed = length(wind) / max(1e-6, uWindRange.y);

  vec2 lonLat = gridToLonLat(pos);
  vec2 world = lonLatToWorld(lonLat);
  gl_Position = uMvp * vec4(world, 0.0, 1.0);
  gl_PointSize = 1.6;
}
`;

const DRAW_FS = /* glsl */ `#version 300 es
precision highp float;
in float vSpeed;
uniform sampler2D uLut;
uniform float uOpacity;
out vec4 outColor;
void main() {
  vec3 color = texture(uLut, vec2(clamp(vSpeed, 0.0, 1.0), 0.5)).rgb;
  outColor = vec4(color, uOpacity);
}
`;

// Trails pass: copy the previous trails framebuffer with a fade factor, then
// the draw pass blends particles on top.
const FADE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uPrev;
uniform float uFade;
out vec4 outColor;
void main() {
  outColor = texture(uPrev, vUv) * uFade;
}
`;

// Final pass: draw the trails FBO onto the main target (fullscreen quad).
const PRESENT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTrails;
out vec4 outColor;
void main() {
  outColor = texture(uTrails, vUv);
}
`;

// --- Layer ----------------------------------------------------------------

export interface WindParticleLayerOptions {
  id?: string;
  particleCount?: number; // must be a power of two; rounded up
  colormap?: ColormapName;
  opacity?: number;
  speedFactor?: number;   // how many texture-steps per frame
  dropRate?: number;
  dropRateBump?: number;
  fade?: number;          // 0..1 — higher = longer trails
}

export class WindParticleLayer implements CustomLayerInterface {
  readonly id: string;
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MlMap | null = null;
  private gl: WebGL2RenderingContext | null = null;

  private updateProg: WebGLProgram | null = null;
  private drawProg: WebGLProgram | null = null;
  private fadeProg: WebGLProgram | null = null;
  private presentProg: WebGLProgram | null = null;

  private quadBuffer: WebGLBuffer | null = null;
  private quadVao: WebGLVertexArrayObject | null = null;
  private indexBuffer: WebGLBuffer | null = null;
  private indexVao: WebGLVertexArrayObject | null = null;

  private particleTexA: WebGLTexture | null = null;
  private particleTexB: WebGLTexture | null = null;
  private particleFb: WebGLFramebuffer | null = null;
  private windTex: FloatTexture | null = null;
  private lutTex: FloatTexture | null = null;

  private trailsTexA: WebGLTexture | null = null;
  private trailsTexB: WebGLTexture | null = null;
  private trailsFb: WebGLFramebuffer | null = null;
  private trailsWidth = 0;
  private trailsHeight = 0;

  private lcc: LccUniforms | null = null;

  // CPU-side U/V retained for click-to-inspect sampling.
  private uValues: Float32Array | null = null;
  private vValues: Float32Array | null = null;
  private windNx = 0;
  private windNy = 0;

  private particleCols = 256;
  private particleRows = 256;
  private speedRange: [number, number] = [0, 30];
  private speedFactor: number;
  private dropRate: number;
  private dropRateBump: number;
  private fade: number;
  private opacity: number;
  private cmapName: ColormapName;
  private particleCount: number;
  private visible = true;

  constructor(opts: WindParticleLayerOptions = {}) {
    this.id = opts.id ?? 'gribwebview-wind';
    this.particleCount = opts.particleCount ?? 65536;
    this.speedFactor = opts.speedFactor ?? 0.00015;
    this.dropRate = opts.dropRate ?? 0.003;
    this.dropRateBump = opts.dropRateBump ?? 0.01;
    this.fade = opts.fade ?? 0.94;
    this.opacity = opts.opacity ?? 0.85;
    this.cmapName = opts.colormap ?? 'turbo';
  }

  onAdd(map: MlMap, glAny: WebGL2RenderingContext | WebGLRenderingContext): void {
    const gl = glAny as WebGL2RenderingContext;
    this.map = map;
    this.gl = gl;
    enableFloatTextureExtensions(gl);

    this.updateProg = buildProgram(gl, QUAD_VS, UPDATE_FS, 'wind.update');
    this.drawProg = buildProgram(gl, DRAW_VS, DRAW_FS, 'wind.draw');
    this.fadeProg = buildProgram(gl, QUAD_VS, FADE_FS, 'wind.fade');
    this.presentProg = buildProgram(gl, QUAD_VS, PRESENT_FS, 'wind.present');

    // Shared fullscreen quad
    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
    this.quadBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
    this.quadVao = gl.createVertexArray();
    gl.bindVertexArray(this.quadVao);
    {
      const loc = gl.getAttribLocation(this.updateProg, 'aPos');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);

    this.particleCount = nextPOT(this.particleCount);
    this.particleCols = Math.ceil(Math.sqrt(this.particleCount));
    this.particleRows = Math.ceil(this.particleCount / this.particleCols);

    const indices = new Float32Array(this.particleCols * this.particleRows);
    for (let i = 0; i < indices.length; i++) indices[i] = i;
    this.indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.indexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);
    this.indexVao = gl.createVertexArray();
    gl.bindVertexArray(this.indexVao);
    {
      const loc = gl.getAttribLocation(this.drawProg, 'aIndex');
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 1, gl.FLOAT, false, 0, 0);
    }
    gl.bindVertexArray(null);

    // Particle state textures (random initial positions)
    const initial = new Uint8Array(this.particleCols * this.particleRows * 4);
    for (let i = 0; i < initial.length; i++) initial[i] = Math.floor(Math.random() * 256);
    this.particleTexA = createDataTexture(gl, this.particleCols, this.particleRows, initial);
    this.particleTexB = createDataTexture(gl, this.particleCols, this.particleRows, initial);
    this.particleFb = gl.createFramebuffer();

    this.lutTex = createColormapTexture(gl, colormap(this.cmapName));
  }

  /**
   * Upload a new wind field. Expects two DecodedFields (u, v) on the same
   * grid, and the grid definition for LCC uniforms. Speed range is derived
   * from the magnitude across both components.
   */
  setWind(u: DecodedField, v: DecodedField, grid: LambertConformalGrid): void {
    if (!this.gl) throw new Error('setWind before onAdd');
    if (u.nx !== v.nx || u.ny !== v.ny) throw new Error('u/v grid mismatch');
    const n = u.nx * u.ny;
    const uv = new Float32Array(n * 2);
    let maxSpeed = 0;
    for (let i = 0; i < n; i++) {
      const uu = u.values[i]!;
      const vv = v.values[i]!;
      uv[i * 2] = uu;
      uv[i * 2 + 1] = vv;
      const s = Math.hypot(uu, vv);
      if (s > maxSpeed && Number.isFinite(s)) maxSpeed = s;
    }
    if (this.windTex) this.gl.deleteTexture(this.windTex.tex);
    this.windTex = createVectorTexture(this.gl, u.nx, u.ny, uv);
    this.lcc = computeLccUniforms(grid);
    this.speedRange = [0, Math.max(1, maxSpeed)];
    this.uValues = u.values;
    this.vValues = v.values;
    this.windNx = u.nx;
    this.windNy = u.ny;
    this.map?.triggerRepaint();
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    this.map?.triggerRepaint();
  }
  isVisible(): boolean { return this.visible; }

  /**
   * Sample the wind (u, v) at a geographic point via bilinear interpolation,
   * and also derive speed + meteorological wind direction (where the wind is
   * coming FROM, degrees clockwise from north). Returns null if the point is
   * outside the grid or no wind data has been loaded.
   */
  sampleAt(lonDeg: number, latDeg: number): { u: number; v: number; speed: number; directionDeg: number } | null {
    if (!this.uValues || !this.vValues || !this.lcc) return null;
    const { u, v } = lonLatToGridUV(this.lcc, lonDeg, latDeg);
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;

    const nx = this.windNx, ny = this.windNy;
    const fx = u * (nx - 1);
    const fy = v * (ny - 1);
    const i0 = Math.floor(fx), j0 = Math.floor(fy);
    const i1 = Math.min(nx - 1, i0 + 1);
    const j1 = Math.min(ny - 1, j0 + 1);
    const tx = fx - i0;
    const ty = fy - j0;
    const bilin = (arr: Float32Array): number => {
      const v00 = arr[j0 * nx + i0]!;
      const v10 = arr[j0 * nx + i1]!;
      const v01 = arr[j1 * nx + i0]!;
      const v11 = arr[j1 * nx + i1]!;
      const top = v00 * (1 - tx) + v10 * tx;
      const bot = v01 * (1 - tx) + v11 * tx;
      return top * (1 - ty) + bot * ty;
    };
    const uu = bilin(this.uValues);
    const vv = bilin(this.vValues);
    const speed = Math.hypot(uu, vv);
    // Meteorological convention: direction wind comes FROM, 0° = North, CW.
    // atan2(-u, -v) gives the "coming from" bearing in [-π, π]; fold to [0, 360).
    let dir = (Math.atan2(-uu, -vv) * 180) / Math.PI;
    if (dir < 0) dir += 360;
    return { u: uu, v: vv, speed, directionDeg: dir };
  }

  render(glAny: WebGL2RenderingContext | WebGLRenderingContext, matrix: mat4): void {
    const gl = glAny as WebGL2RenderingContext;
    if (!this.visible) return;
    if (!this.updateProg || !this.drawProg || !this.windTex || !this.lcc || !this.lutTex) return;

    // Make sure our trails FBO matches the viewport size.
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const vw = viewport[2]!;
    const vh = viewport[3]!;
    this.ensureTrailsFbo(gl, vw, vh);

    // -------- 1. Update particles (ping-pong particleTexA -> particleTexB)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.particleFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.particleTexB, 0);
    gl.viewport(0, 0, this.particleCols, this.particleRows);
    gl.useProgram(this.updateProg);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.particleTexA);
    gl.uniform1i(gl.getUniformLocation(this.updateProg, 'uParticles'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.windTex.tex);
    gl.uniform1i(gl.getUniformLocation(this.updateProg, 'uWind'), 1);
    gl.uniform2f(gl.getUniformLocation(this.updateProg, 'uWindRange'), this.speedRange[0], this.speedRange[1]);
    gl.uniform1f(gl.getUniformLocation(this.updateProg, 'uSpeedFactor'), this.speedFactor);
    gl.uniform1f(gl.getUniformLocation(this.updateProg, 'uDropRate'), this.dropRate);
    gl.uniform1f(gl.getUniformLocation(this.updateProg, 'uDropRateBump'), this.dropRateBump);
    gl.uniform2f(gl.getUniformLocation(this.updateProg, 'uRand'), Math.random(), Math.random());
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // -------- 2. Fade trails A -> B
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.trailsFb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.trailsTexB, 0);
    gl.viewport(0, 0, this.trailsWidth, this.trailsHeight);
    gl.useProgram(this.fadeProg!);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trailsTexA);
    gl.uniform1i(gl.getUniformLocation(this.fadeProg!, 'uPrev'), 0);
    gl.uniform1f(gl.getUniformLocation(this.fadeProg!, 'uFade'), this.fade);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // -------- 3. Draw particles onto trails B
    gl.useProgram(this.drawProg);
    gl.bindVertexArray(this.indexVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.particleTexB); // latest positions
    gl.uniform1i(gl.getUniformLocation(this.drawProg, 'uParticles'), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.windTex.tex);
    gl.uniform1i(gl.getUniformLocation(this.drawProg, 'uWind'), 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex.tex);
    gl.uniform1i(gl.getUniformLocation(this.drawProg, 'uLut'), 2);
    gl.uniform2f(gl.getUniformLocation(this.drawProg, 'uParticleGrid'), this.particleCols, this.particleRows);
    gl.uniform2f(gl.getUniformLocation(this.drawProg, 'uWindRange'), this.speedRange[0], this.speedRange[1]);
    gl.uniform2f(gl.getUniformLocation(this.drawProg, 'uViewport'), vw, vh);
    gl.uniformMatrix4fv(gl.getUniformLocation(this.drawProg, 'uMvp'), false, matrix);
    gl.uniform1f(gl.getUniformLocation(this.drawProg, 'uOpacity'), this.opacity);

    // LCC uniforms (shared helper)
    this.pushLccUniforms(gl, this.drawProg);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    gl.drawArrays(gl.POINTS, 0, this.particleCount);

    // -------- 4. Present trails B to the actual MapLibre framebuffer
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, vw, vh);
    gl.useProgram(this.presentProg!);
    gl.bindVertexArray(this.quadVao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.trailsTexB);
    gl.uniform1i(gl.getUniformLocation(this.presentProg!, 'uTrails'), 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Restore MapLibre-expected GL state. We rebind the default program,
    // VAO, buffers, textures, and blend func. Without this, subsequent
    // vector layers (roads, labels, coastline stroke) composite incorrectly
    // because we leave `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` dirty instead of
    // the premultiplied-alpha setup MapLibre uses internally.
    gl.bindVertexArray(null);
    gl.useProgram(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Swap ping-pong buffers for next frame
    [this.particleTexA, this.particleTexB] = [this.particleTexB, this.particleTexA];
    [this.trailsTexA, this.trailsTexB] = [this.trailsTexB, this.trailsTexA];

    this.map?.triggerRepaint(); // animate
  }

  onRemove(_map: MlMap, glAny: WebGL2RenderingContext | WebGLRenderingContext): void {
    const gl = glAny as WebGL2RenderingContext;
    for (const t of [this.particleTexA, this.particleTexB, this.trailsTexA, this.trailsTexB, this.windTex?.tex, this.lutTex?.tex]) {
      if (t) gl.deleteTexture(t);
    }
    if (this.particleFb) gl.deleteFramebuffer(this.particleFb);
    if (this.trailsFb) gl.deleteFramebuffer(this.trailsFb);
    if (this.quadBuffer) gl.deleteBuffer(this.quadBuffer);
    if (this.indexBuffer) gl.deleteBuffer(this.indexBuffer);
    if (this.quadVao) gl.deleteVertexArray(this.quadVao);
    if (this.indexVao) gl.deleteVertexArray(this.indexVao);
    for (const p of [this.updateProg, this.drawProg, this.fadeProg, this.presentProg]) {
      if (p) gl.deleteProgram(p);
    }
  }

  private ensureTrailsFbo(gl: WebGL2RenderingContext, w: number, h: number): void {
    if (w === this.trailsWidth && h === this.trailsHeight && this.trailsFb) return;
    if (this.trailsTexA) gl.deleteTexture(this.trailsTexA);
    if (this.trailsTexB) gl.deleteTexture(this.trailsTexB);
    const empty = new Uint8Array(w * h * 4);
    this.trailsTexA = createDataTexture(gl, w, h, empty);
    this.trailsTexB = createDataTexture(gl, w, h, empty);
    if (!this.trailsFb) this.trailsFb = gl.createFramebuffer();
    this.trailsWidth = w;
    this.trailsHeight = h;
  }

  private pushLccUniforms(gl: WebGL2RenderingContext, prog: WebGLProgram): void {
    const u = this.lcc!;
    gl.uniform1f(gl.getUniformLocation(prog, 'uLccN'), u.n);
    gl.uniform1f(gl.getUniformLocation(prog, 'uLccF'), u.F);
    gl.uniform1f(gl.getUniformLocation(prog, 'uLccRho0'), u.rho0);
    gl.uniform1f(gl.getUniformLocation(prog, 'uLccLambda0'), u.lambda0);
    gl.uniform1f(gl.getUniformLocation(prog, 'uLccRadius'), u.radius);
    gl.uniform2f(gl.getUniformLocation(prog, 'uLccOrigin'), u.originX, u.originY);
    gl.uniform2f(gl.getUniformLocation(prog, 'uLccStep'), u.dx, u.dy);
    gl.uniform2f(gl.getUniformLocation(prog, 'uLccGridSize'), u.nx, u.ny);
    gl.uniform2f(gl.getUniformLocation(prog, 'uLccScan'), u.scanX, u.scanY);
  }
}

function createDataTexture(gl: WebGL2RenderingContext, w: number, h: number, data: Uint8Array): WebGLTexture {
  const tex = gl.createTexture();
  if (!tex) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  return tex;
}

function nextPOT(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
