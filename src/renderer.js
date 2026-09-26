import {
  createContext, program, FULLSCREEN_VS, uniformSetter,
  createFloatTexture, createRgbaTexture, mipLevels,
} from './gl/context.js';
import { MAX_REDUCE_FS, SKYVIEW_FS, IRRADIANCE_FS, COLORIZE_FS } from './gl/shaders.js';
import { sunPosition } from './solar.js';
import { clearSky } from './radiation.js';

export const MODES = { binary: 0, power: 1, energy: 2, sunHours: 3, slope: 4 };

const MARCH = { firstStep: 0.7, growth: 1.02, lodBias: -1.0, maxDistanceMetres: 150000 };

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    const gl = (this.gl = createContext(canvas));
    this.programs = {
      reduce: program(gl, FULLSCREEN_VS, MAX_REDUCE_FS),
      skyView: program(gl, FULLSCREEN_VS, SKYVIEW_FS),
      irradiance: program(gl, FULLSCREEN_VS, IRRADIANCE_FS),
      colorize: program(gl, FULLSCREEN_VS, COLORIZE_FS),
    };
    this.uniforms = Object.fromEntries(
      Object.entries(this.programs).map(([k, p]) => [k, uniformSetter(gl, p)])
    );
    this.march = { ...MARCH };
    this.fbo = gl.createFramebuffer();
    this.vao = gl.createVertexArray();
    this.field = null;
  }

  draw() {
    this.gl.bindVertexArray(this.vao);
    this.gl.drawArrays(this.gl.TRIANGLES, 0, 3);
  }

  target(texture, level = 0) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, level);
  }

  /** Upload a heightfield and rebuild everything that depends only on terrain. */
  setHeightfield(hf) {
    const gl = this.gl;
    const { width, height } = hf;
    this.release();

    const levels = mipLevels(width, height);
    this.heightTex = createFloatTexture(gl, width, height, levels, true);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, gl.RED, gl.FLOAT, hf.data);

    this.skyViewTex = createFloatTexture(gl, width, height);
    this.accum = [createRgbaTexture(gl, width, height), createRgbaTexture(gl, width, height)];
    let lo = Infinity, hi = -Infinity;
    for (const v of hf.data) { if (v < lo) lo = v; if (v > hi) hi = v; }
    this.field = { ...hf, levels, elevationRange: [lo, hi] };

    this.canvas.width = width;
    this.canvas.height = height;

    this.buildMaxMipmap();
    this.buildSkyView();
  }

  buildMaxMipmap() {
    const gl = this.gl;
    const { width, height, levels } = this.field;
    gl.useProgram(this.programs.reduce);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    this.uniforms.reduce.i('uSource', 0);
    for (let level = 1; level < levels; level++) {
      const w = Math.max(1, width >> level);
      const h = Math.max(1, height >> level);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, level - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level - 1);
      this.target(this.heightTex, level);
      gl.viewport(0, 0, w, h);
      this.uniforms.reduce.i('uLevel', 0);
      this.draw();
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
  }

  marchUniforms(u) {
    const { width, height, metresPerPixel } = this.field;
    u.v2('uSize', width, height);
    u.f('uMpp', metresPerPixel);
    u.f('uMaxDistPx', this.march.maxDistanceMetres / metresPerPixel);
    u.f('uFirstStep', this.march.firstStep);
    u.f('uGrowth', this.march.growth);
    u.f('uLodBias', this.march.lodBias);
  }

  buildSkyView(azimuths = 16) {
    const gl = this.gl;
    const { width, height } = this.field;
    gl.useProgram(this.programs.skyView);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    this.uniforms.skyView.i('uHeight', 0);
    this.uniforms.skyView.i('uAzimuths', azimuths);
    this.marchUniforms(this.uniforms.skyView);
    this.target(this.skyViewTex);
    gl.viewport(0, 0, width, height);
    this.draw();
  }

  clearAccumulator() {
    const gl = this.gl;
    for (const tex of this.accum) {
      this.target(tex);
      gl.viewport(0, 0, this.field.width, this.field.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.accumIndex = 0;
    this.samples = 0;
  }

  /** Accumulate one instant into the running total. */
  addTimestep(date, { albedo = 0.6 } = {}) {
    const gl = this.gl;
    const { width, height, centre, elevationRange } = this.field;
    const sun = sunPosition(centre.lat, centre.lon, date);

    const [lo, hi] = elevationRange;
    const low = clearSky(sun.elevation, lo, date);
    const high = clearSky(sun.elevation, hi, date);

    const src = this.accum[this.accumIndex];
    const dst = this.accum[1 - this.accumIndex];

    gl.useProgram(this.programs.irradiance);
    const u = this.uniforms.irradiance;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.skyViewTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, src);
    u.i('uHeight', 0); u.i('uSkyView', 1); u.i('uPrevious', 2);
    this.marchUniforms(u);
    u.f('uSunAz', sun.azimuth);
    u.f('uSunEl', sun.elevation);
    u.f('uAlbedo', albedo);
    u.v3('uDni', low.dni, high.dni, 0);
    u.v3('uDhi', low.dhi, high.dhi, 0);
    u.v3('uGhi', low.ghi, high.ghi, 0);
    u.v2('uAltRange', lo, hi);

    this.target(dst);
    gl.viewport(0, 0, width, height);
    this.draw();

    this.accumIndex = 1 - this.accumIndex;
    this.samples++;
    return sun;
  }

  colorize({ mode = MODES.binary, scale = 1000, stepHours = 0.25, opacity = 0.75 }) {
    const gl = this.gl;
    const { width, height, metresPerPixel } = this.field;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.programs.colorize);
    const u = this.uniforms.colorize;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.accum[this.accumIndex]);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    u.i('uAccum', 0); u.i('uHeight', 1);
    u.v2('uSize', width, height);
    u.i('uMode', mode);
    u.f('uScale', scale);
    u.f('uStepHours', stepHours);
    u.f('uMpp', metresPerPixel);
    u.f('uOpacity', opacity);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.draw();
  }

  readPixel(texture, x, y) {
    const gl = this.gl;
    this.target(texture);
    const out = new Float32Array(4);
    gl.readPixels(x, y, 1, 1, gl.RGBA, gl.FLOAT, out);
    return out;
  }

  release() {
    const gl = this.gl;
    for (const t of [this.heightTex, this.skyViewTex, ...(this.accum || [])]) if (t) gl.deleteTexture(t);
    this.heightTex = this.skyViewTex = null;
    this.accum = null;
  }
}
