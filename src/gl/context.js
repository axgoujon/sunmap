export function createContext(canvas) {
  const gl = canvas.getContext('webgl2', {
    antialias: false,
    preserveDrawingBuffer: true,
    // The colorize pass emits straight alpha; premultiplying would wash the
    // basemap out wherever the overlay is translucent.
    premultipliedAlpha: false,
  });
  if (!gl) throw new Error('WebGL2 is required and is not available in this browser.');
  const float = gl.getExtension('EXT_color_buffer_float');
  if (!float) throw new Error('WebGL2 float render targets (EXT_color_buffer_float) are required.');
  gl.getExtension('OES_texture_float_linear');
  return gl;
}

export function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader compile failed: ${log}`);
  }
  return shader;
}

export function program(gl, vertexSource, fragmentSource) {
  const p = gl.createProgram();
  const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(`program link failed: ${gl.getProgramInfoLog(p)}`);
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return p;
}

// Every pass is a full-screen triangle; no vertex data is needed.
export const FULLSCREEN_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2);
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

export function uniformSetter(gl, prog) {
  const cache = new Map();
  const loc = (name) => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(prog, name));
    return cache.get(name);
  };
  return {
    f: (n, v) => gl.uniform1f(loc(n), v),
    i: (n, v) => gl.uniform1i(loc(n), v),
    v2: (n, x, y) => gl.uniform2f(loc(n), x, y),
    v3: (n, x, y, z) => gl.uniform3f(loc(n), x, y, z),
  };
}

export function createFloatTexture(gl, width, height, levels = 1, linear = false) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, levels, gl.R32F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  // Linear sampling of the heightfield matters: nearest picks a single texel,
  // which in steep terrain is often a local maximum and casts false shadows.
  const min = linear
    ? (levels > 1 ? gl.LINEAR_MIPMAP_NEAREST : gl.LINEAR)
    : (levels > 1 ? gl.NEAREST_MIPMAP_NEAREST : gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, min);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, linear ? gl.LINEAR : gl.NEAREST);
  return tex;
}

export function createRgbaTexture(gl, width, height) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, width, height);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  return tex;
}

export const mipLevels = (w, h) => Math.floor(Math.log2(Math.max(w, h))) + 1;
