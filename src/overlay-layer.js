// The computed map drawn as a MapLibre custom layer: one textured quad over
// the terrain's bounds, re-uploaded only when a new result is ready.
//
// MapLibre's own 'canvas' source used to do this, but from Chrome 154 any
// canvas source turns the whole map black (even a 64 px 2D canvas), while
// image sources and custom layers draw fine.
import { TILE_SIZE } from './tiles.js';

const VERTEX = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform mat4 u_matrix;
varying vec2 v_uv;
void main() {
  v_uv = a_uv;
  gl_Position = u_matrix * vec4(a_pos, 0.0, 1.0);
}`;

// The overlay holds straight (not premultiplied) alpha; MapLibre composites
// premultiplied colour.
const FRAGMENT = `
precision mediump float;
uniform sampler2D u_texture;
varying vec2 v_uv;
void main() {
  vec4 c = texture2D(u_texture, v_uv);
  gl_FragColor = vec4(c.rgb * c.a, c.a);
}`;

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export class OverlayLayer {
  constructor(id, source) {
    this.id = id;
    this.type = 'custom';
    this.renderingMode = '2d';
    this.source = source;
    this.visible = true;
    this.dirty = false;
    this.quad = null;
  }

  onAdd(map, gl) {
    this.map = map;
    const program = (this.program = gl.createProgram());
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    this.loc = {
      pos: gl.getAttribLocation(program, 'a_pos'),
      uv: gl.getAttribLocation(program, 'a_uv'),
      matrix: gl.getUniformLocation(program, 'u_matrix'),
      texture: gl.getUniformLocation(program, 'u_texture'),
    };
    this.buffer = gl.createBuffer();
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.hasImage = false;
    this.quadDirty = !!this.quad;
  }

  onRemove(map, gl) {
    gl.deleteTexture(this.texture);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
  }

  /**
   * Places the overlay over a heightfield's mosaic. Corners come from its
   * Web Mercator tile origin, which is exactly what MapLibre projects with,
   * so overlay pixels sit on the terrain pixels they were computed for.
   */
  setMosaic({ z, originX, originY, width, height }) {
    const n = 2 ** z * TILE_SIZE;
    const x0 = (originX * TILE_SIZE) / n, y0 = (originY * TILE_SIZE) / n;
    const x1 = x0 + width / n, y1 = y0 + height / n;
    // x, y in Mercator units (0..1 across the world, y down), then u, v with
    // v = 0 at the canvas' top row, which is north.
    this.quad = new Float32Array([x0, y0, 0, 0, x1, y0, 1, 0, x0, y1, 0, 1, x1, y1, 1, 1]);
    this.quadDirty = true;
    this.map?.triggerRepaint();
  }

  /** A new result is in the source canvas. */
  update() {
    this.dirty = true;
    this.map?.triggerRepaint();
  }

  setVisible(visible) {
    this.visible = visible;
    this.map?.triggerRepaint();
  }

  render(gl, matrix) {
    if (!this.visible || !this.quad) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    if (this.quadDirty) {
      gl.bufferData(gl.ARRAY_BUFFER, this.quad, gl.STATIC_DRAW);
      this.quadDirty = false;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    if (this.dirty) {
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.source);
      this.dirty = false;
      this.hasImage = true;
    }
    if (!this.hasImage) return;
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.loc.pos);
    gl.vertexAttribPointer(this.loc.pos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(this.loc.uv);
    gl.vertexAttribPointer(this.loc.uv, 2, gl.FLOAT, false, 16, 8);
    gl.uniformMatrix4fv(this.loc.matrix, false, matrix);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(this.loc.texture, 0);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
