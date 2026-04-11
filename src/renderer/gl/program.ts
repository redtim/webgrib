/**
 * Thin WebGL2 program/shader helpers. No cleverness — compile, link, fail
 * loudly. Every shader compile error includes a numbered listing of the
 * source to make shader debugging not a scavenger hunt.
 */

export function compileShader(gl: WebGL2RenderingContext, type: GLenum, source: string, label: string): WebGLShader {
  const sh = gl.createShader(type);
  if (!sh) throw new Error(`glCreateShader failed for ${label}`);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '';
    gl.deleteShader(sh);
    throw new Error(`Shader compile failed (${label}):\n${log}\n${numbered(source)}`);
  }
  return sh;
}

export function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader, label: string, transformFeedback?: { varyings: string[]; bufferMode: GLenum }): WebGLProgram {
  const prog = gl.createProgram();
  if (!prog) throw new Error(`glCreateProgram failed for ${label}`);
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  if (transformFeedback) {
    gl.transformFeedbackVaryings(prog, transformFeedback.varyings, transformFeedback.bufferMode);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '';
    gl.deleteProgram(prog);
    throw new Error(`Program link failed (${label}):\n${log}`);
  }
  return prog;
}

export function buildProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
  label = 'program',
  transformFeedback?: { varyings: string[]; bufferMode: GLenum },
): WebGLProgram {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vertexSource, `${label}.vs`);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource, `${label}.fs`);
  const prog = linkProgram(gl, vs, fs, label, transformFeedback);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

function numbered(src: string): string {
  return src.split('\n').map((l, i) => `${String(i + 1).padStart(4)} | ${l}`).join('\n');
}
