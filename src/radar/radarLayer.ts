/**
 * MapLibre custom WebGL2 layer for one radar tilt. A single quad covers the
 * radar's range; for each fragment the shader works out the azimuth and beam
 * distance back to the antenna and reads that gate directly, so the polar data
 * stays sharp at any zoom with no resampling.
 */

import type { CustomLayerInterface, Map as MlMap } from 'maplibre-gl';
import { buildProgram } from '../renderer/gl/program.js';
import { buildLut, PRODUCTS, RANGE_FOLDED_COLOR, type ProductId } from './colors.js';
import { coverageQuad, type PolarGrid } from './polar.js';

const VS = /* glsl */ `#version 300 es
in vec2 aMercator;
uniform mat4 uMatrix;
out vec2 vMercator;
void main() {
  vMercator = aMercator;
  gl_Position = uMatrix * vec4(aMercator, 0.0, 1.0);
}
`;

const FS = /* glsl */ `#version 300 es
precision highp float;
precision highp usampler2D;

const float PI = 3.14159265358979;
const float EARTH_RADIUS = 6371000.0;
// Standard refraction: the beam behaves as if the earth were 4/3 as large.
const float REFRACTION = 4.0 / 3.0;

uniform usampler2D uData;     // gate codes; x = gate, y = azimuth row
uniform float uScale;
uniform float uOffset;
uniform sampler2D uLut;
uniform float uSiteX;         // radar mercator x
uniform float uSiteLat;       // radians
uniform float uElevation;     // radians
uniform float uFirstGate;     // metres
uniform float uGateSpacing;   // metres
uniform vec2  uValueRange;
uniform vec3  uFoldedColor;
uniform float uOpacity;

in vec2 vMercator;
out vec4 outColor;

void main() {
  float dLon = (vMercator.x - uSiteX) * 2.0 * PI;
  float lat = atan(sinh(PI * (1.0 - 2.0 * vMercator.y)));

  // Haversine distance and bearing, in forms that stay accurate near the radar.
  float sLat = sin(0.5 * (lat - uSiteLat));
  float sLon = sin(0.5 * dLon);
  float h = sLat * sLat + cos(uSiteLat) * cos(lat) * sLon * sLon;
  float arc = 2.0 * asin(min(1.0, sqrt(h)));
  float azimuth = atan(
    sin(dLon) * cos(lat),
    sin(lat - uSiteLat) + 2.0 * sin(uSiteLat) * cos(lat) * sLon * sLon);

  // Ground distance → distance along the tilted beam.
  float theta = arc / REFRACTION;
  float slant = REFRACTION * EARTH_RADIUS * sin(theta) / cos(uElevation + theta);

  ivec2 size = textureSize(uData, 0);
  int gate = int(floor((slant - uFirstGate) / uGateSpacing + 0.5));
  if (gate < 0 || gate >= size.x) discard;
  int row = min(int(fract(azimuth / (2.0 * PI)) * float(size.y)), size.y - 1);

  // Codes as in the file: 0 = no echo, 1 = range folded.
  uint code = texelFetch(uData, ivec2(gate, row), 0).r;
  if (code == 0u) discard;

  vec4 color;
  if (code == 1u) {
    color = vec4(uFoldedColor, 1.0);
  } else {
    float v = uScale == 0.0 ? float(code) : (float(code) - uOffset) / uScale;
    float t = (v - uValueRange.x) / (uValueRange.y - uValueRange.x);
    color = texelFetch(uLut, ivec2(clamp(int(t * 256.0), 0, 255), 0), 0);
  }
  float alpha = color.a * uOpacity;
  outColor = vec4(color.rgb * alpha, alpha);   // MapLibre blends premultiplied
}
`;

export interface RadarFrame {
  latitude: number;
  longitude: number;
  product: ProductId;
  grid: PolarGrid;
}

export class RadarLayer implements CustomLayerInterface {
  readonly id = 'radar';
  readonly type = 'custom' as const;
  readonly renderingMode = '2d' as const;

  private map: MlMap | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private quad: WebGLBuffer | null = null;
  private dataTexture: WebGLTexture | null = null;
  private lutTexture: WebGLTexture | null = null;
  private frame: RadarFrame | null = null;
  /** Set when `frame` has changed and the GPU copies are stale. */
  private dirty = false;
  private opacity = 0.85;

  setFrame(frame: RadarFrame | null): void {
    this.frame = frame;
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  onAdd(map: MlMap, glAny: WebGLRenderingContext | WebGL2RenderingContext): void {
    const gl = glAny as WebGL2RenderingContext;
    this.map = map;
    this.program = buildProgram(gl, VS, FS, 'radar');
    this.vao = gl.createVertexArray();
    this.quad = gl.createBuffer();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    const location = gl.getAttribLocation(this.program, 'aMercator');
    gl.enableVertexAttribArray(location);
    gl.vertexAttribPointer(location, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.dataTexture = createNearestTexture(gl);
    this.lutTexture = createNearestTexture(gl);
    this.dirty = true;
  }

  private upload(gl: WebGL2RenderingContext, frame: RadarFrame): void {
    const { grid } = frame;
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
    const bytes = grid.data instanceof Uint8Array;
    gl.texImage2D(gl.TEXTURE_2D, 0, bytes ? gl.R8UI : gl.R16UI, grid.gateCount, grid.azimuthBins, 0,
      gl.RED_INTEGER, bytes ? gl.UNSIGNED_BYTE : gl.UNSIGNED_SHORT, grid.data);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, buildLut(PRODUCTS[frame.product]));

    const radius = grid.firstGate + grid.gateCount * grid.gateSpacing;
    const [west, north, east, south] = coverageQuad(frame.latitude, frame.longitude, radius);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([west, north, west, south, east, north, east, south]), gl.STATIC_DRAW);
  }

  render(glAny: WebGLRenderingContext | WebGL2RenderingContext, matrix: Parameters<CustomLayerInterface['render']>[1]): void {
    const gl = glAny as WebGL2RenderingContext;
    const { frame, program } = this;
    if (!frame || !program) return;

    gl.activeTexture(gl.TEXTURE0);
    if (this.dirty) {
      this.upload(gl, frame);
      this.dirty = false;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.dataTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTexture);

    const rad = Math.PI / 180;
    const product = PRODUCTS[frame.product];
    const at = (name: string) => gl.getUniformLocation(program, name);
    gl.useProgram(program);
    gl.uniformMatrix4fv(at('uMatrix'), false, matrix as Float32Array);
    gl.uniform1i(at('uData'), 0);
    gl.uniform1f(at('uScale'), frame.grid.scale);
    gl.uniform1f(at('uOffset'), frame.grid.offset);
    gl.uniform1i(at('uLut'), 1);
    gl.uniform1f(at('uSiteX'), (frame.longitude + 180) / 360);
    gl.uniform1f(at('uSiteLat'), frame.latitude * rad);
    gl.uniform1f(at('uElevation'), frame.grid.elevation * rad);
    gl.uniform1f(at('uFirstGate'), frame.grid.firstGate);
    gl.uniform1f(at('uGateSpacing'), frame.grid.gateSpacing);
    gl.uniform2f(at('uValueRange'), product.min, product.max);
    const [r, g, b] = RANGE_FOLDED_COLOR;
    gl.uniform3f(at('uFoldedColor'), r / 255, g / 255, b / 255);
    gl.uniform1f(at('uOpacity'), this.opacity);

    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  onRemove(_map: MlMap, glAny: WebGLRenderingContext | WebGL2RenderingContext): void {
    const gl = glAny as WebGL2RenderingContext;
    gl.deleteProgram(this.program);
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.quad);
    gl.deleteTexture(this.dataTexture);
    gl.deleteTexture(this.lutTexture);
    this.map = null;
  }
}

/** Unfiltered texture: gates are read exactly, as integer textures require. */
function createNearestTexture(gl: WebGL2RenderingContext): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error('createTexture failed');
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}
