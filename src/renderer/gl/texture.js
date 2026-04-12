/**
 * Texture upload helpers. The scalar field path uploads Float32Array to R32F;
 * the wind path uses RG32F; colormaps are 1D RGBA8 LUTs.
 *
 * WebGL2 supports float textures but not always as color-renderable or
 * linear-filterable without extensions. For sampling we only need linear
 * filtering of R32F, which requires OES_texture_float_linear on many
 * platforms.
 */
export function enableFloatTextureExtensions(gl) {
    // Required for linear filtering of float textures on most desktop GL.
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_color_buffer_float');
}
export function createScalarTexture(gl, width, height, data) {
    const tex = gl.createTexture();
    if (!tex)
        throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, width, height, 0, gl.RED, gl.FLOAT, data);
    return { tex, width, height };
}
export function createVectorTexture(gl, width, height, uv) {
    const tex = gl.createTexture();
    if (!tex)
        throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, width, height, 0, gl.RG, gl.FLOAT, uv);
    return { tex, width, height };
}
export function createColormapTexture(gl, lut) {
    const tex = gl.createTexture();
    if (!tex)
        throw new Error('createTexture failed');
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, lut.length / 4, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, lut);
    return { tex, width: lut.length / 4, height: 1 };
}
