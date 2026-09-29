import {
  createContext, program, FULLSCREEN_VS, uniformSetter,
  createFloatTexture, createRgbaTexture, mipLevels,
} from './gl/context.js';
import { MAX_REDUCE_FS, SKYVIEW_FS, IRRADIANCE_FS, COLORIZE_FS } from './gl/shaders.js';
import { sunPosition } from './solar.js';
import { clearSky } from './radiation.js';
import { TILE_SIZE } from './tiles.js';

export const MODES = { binary: 0, power: 1, energy: 2, sunHours: 3, slope: 4 };

// Distances in metres. A 10-degree winter sun over 3800 m of relief casts
// shadows about 21 km long; the max-height exit usually stops rays far sooner.
// Growth 1.05 matched a dense reference march as well as 1.02 did (397-399 of
// 400 points at 5 and 15 degree suns) at under half the cost: the max-mip
// lookups keep long steps from skipping ridges.
const MARCH = { firstStepPx: 0.7, growth: 1.05, lodBias: -1.0, maxDistanceMetres: 150000 };
const SKY_SCALE = 2;

function extent(data) {
  let lo = Infinity, hi = -Infinity;
  for (const v of data) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return [lo, hi];
}

export class Renderer {
  constructor(canvas, { manualFiltering = false } = {}) {
    this.canvas = canvas;
    const gl = (this.gl = createContext(canvas));
    // Many phone GPUs cannot filter float textures. There the heightfields
    // must use nearest filtering (otherwise they are incomplete and every
    // lookup reads zero) and the shaders blend neighbours themselves.
    this.hardwareFiltering = !manualFiltering && !!gl.getExtension('OES_texture_float_linear');
    const define = (src) => this.hardwareFiltering
      ? src
      : src.replace('#version 300 es', '#version 300 es\n#define MANUAL_BILINEAR');
    this.programs = {
      reduce: program(gl, FULLSCREEN_VS, MAX_REDUCE_FS),
      skyView: program(gl, FULLSCREEN_VS, define(SKYVIEW_FS)),
      irradiance: program(gl, FULLSCREEN_VS, define(IRRADIANCE_FS)),
      colorize: program(gl, FULLSCREEN_VS, define(COLORIZE_FS)),
    };
    this.uniforms = Object.fromEntries(
      Object.entries(this.programs).map(([k, p]) => [k, uniformSetter(gl, p)])
    );
    this.march = { ...MARCH };
    this.fbo = gl.createFramebuffer();
    this.vao = gl.createVertexArray();
    this.field = null;
    this.far = null;
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

  uploadTerrain(hf) {
    const gl = this.gl;
    const levels = mipLevels(hf.width, hf.height);
    const tex = createFloatTexture(gl, hf.width, hf.height, levels, this.hardwareFiltering);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, hf.width, hf.height, gl.RED, gl.FLOAT, hf.data);
    this.buildMaxMipmap(tex, hf.width, hf.height, levels);
    return { tex, levels, range: extent(hf.data) };
  }

  /**
   * Upload the near and far heightfields and rebuild everything that depends
   * only on terrain. `outScale` output pixels are drawn per terrain pixel.
   */
  setTerrain(hf, far, outScale = 1) {
    const gl = this.gl;
    this.release();

    const near = this.uploadTerrain(hf);
    this.heightTex = near.tex;
    this.field = { ...hf, levels: near.levels, elevationRange: near.range };

    if (far !== this.far || !this.farTex) {
      if (this.farTex) gl.deleteTexture(this.farTex);
      const f = this.uploadTerrain(far);
      this.farTex = f.tex;
      this.far = far;
      this.farInfo = { levels: f.levels, range: f.range };
    }

    this.outScale = outScale;
    this.outWidth = hf.width * outScale;
    this.outHeight = hf.height * outScale;
    this.skyWidth = Math.ceil(hf.width / SKY_SCALE);
    this.skyHeight = Math.ceil(hf.height / SKY_SCALE);
    this.skyViewTex = createFloatTexture(gl, this.skyWidth, this.skyHeight);
    this.accum = [createRgbaTexture(gl, this.outWidth, this.outHeight), createRgbaTexture(gl, this.outWidth, this.outHeight)];
    this.canvas.width = this.outWidth;
    this.canvas.height = this.outHeight;

    this.buildSkyView();
  }

  buildMaxMipmap(tex, width, height, levels) {
    const gl = this.gl;
    gl.useProgram(this.programs.reduce);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    this.uniforms.reduce.i('uSource', 0);
    for (let level = 1; level < levels; level++) {
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, level - 1);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, level - 1);
      this.target(tex, level);
      gl.viewport(0, 0, Math.max(1, width >> level), Math.max(1, height >> level));
      this.uniforms.reduce.i('uLevel', 0);
      this.draw();
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_BASE_LEVEL, 0);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAX_LEVEL, levels - 1);
  }

  bindTerrain(u, outScale) {
    const gl = this.gl;
    const hf = this.field, far = this.far;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE3); gl.bindTexture(gl.TEXTURE_2D, this.farTex);
    u.i('uHeight', 0);
    u.i('uFar', 3);
    u.v2('uSize', hf.width, hf.height);
    u.i('uMaxLevel', hf.levels - 1);
    u.f('uMpp', hf.metresPerPixel);
    u.f('uOut', outScale);

    // Both mosaics live in Web Mercator pixel space at their own zoom, so the
    // mapping between them is a scale by 2^(zFar - zNear) plus an offset.
    const s = 2 ** (far.z - hf.z);
    u.v2('uFarSize', far.width, far.height);
    u.i('uFarMaxLevel', this.farInfo.levels - 1);
    u.f('uFarMpp', hf.metresPerPixel / s);
    u.f('uFarScale', s);
    u.v2('uFarOffset', hf.originX * TILE_SIZE * s - far.originX * TILE_SIZE, hf.originY * TILE_SIZE * s - far.originY * TILE_SIZE);
    u.f('uMaxDist', this.march.maxDistanceMetres);
    u.f('uFirstStep', this.march.firstStepPx * hf.metresPerPixel);
    u.f('uGrowth', this.march.growth);
    u.f('uLodBias', this.march.lodBias);
    u.f('uMaxHeight', Math.max(hf.elevationRange[1], this.farInfo.range[1]));
  }

  buildSkyView(azimuths = 16) {
    const gl = this.gl;
    gl.useProgram(this.programs.skyView);
    this.bindTerrain(this.uniforms.skyView, 1);
    this.uniforms.skyView.i('uAzimuths', azimuths);
    this.uniforms.skyView.f('uSkyScale', SKY_SCALE);
    this.target(this.skyViewTex);
    gl.viewport(0, 0, this.skyWidth, this.skyHeight);
    this.draw();
  }

  clearAccumulator() {
    const gl = this.gl;
    for (const tex of this.accum) {
      this.target(tex);
      gl.viewport(0, 0, this.outWidth, this.outHeight);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.accumIndex = 0;
  }

  /** Add one instant to the running total, or remove it with weight -1. */
  addTimestep(date, { albedo = 0.6, weight = 1 } = {}) {
    const gl = this.gl;
    const { centre, elevationRange } = this.field;
    const sun = sunPosition(centre.lat, centre.lon, date);

    const [lo, hi] = elevationRange;
    const low = clearSky(sun.elevation, lo, date);
    const high = clearSky(sun.elevation, hi, date);

    const src = this.accum[this.accumIndex];
    const dst = this.accum[1 - this.accumIndex];

    gl.useProgram(this.programs.irradiance);
    const u = this.uniforms.irradiance;
    this.bindTerrain(u, this.outScale);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.skyViewTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, src);
    u.i('uSkyView', 1); u.i('uPrevious', 2);
    u.f('uSkyScale', SKY_SCALE);
    u.f('uSunAz', sun.azimuth);
    u.f('uSunEl', sun.elevation);
    u.f('uAlbedo', albedo);
    u.f('uWeight', weight);
    u.v3('uDni', low.dni, high.dni, 0);
    u.v3('uDhi', low.dhi, high.dhi, 0);
    u.v3('uGhi', low.ghi, high.ghi, 0);
    u.v2('uAltRange', lo, hi);

    this.target(dst);
    gl.viewport(0, 0, this.outWidth, this.outHeight);
    this.draw();

    this.accumIndex = 1 - this.accumIndex;
    return sun;
  }

  colorize({ mode = MODES.binary, scale = 1000, stepHours = 0.25, opacity = 0.75, sky = false }) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.outWidth, this.outHeight);
    gl.useProgram(this.programs.colorize);
    const u = this.uniforms.colorize;
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.heightTex);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.accum[this.accumIndex]);
    u.i('uHeight', 0); u.i('uAccum', 1);
    u.v2('uSize', this.field.width, this.field.height);
    u.i('uMaxLevel', this.field.levels - 1);
    u.f('uMpp', this.field.metresPerPixel);
    u.f('uOut', this.outScale);
    u.v2('uOutSize', this.outWidth, this.outHeight);
    u.i('uMode', mode);
    u.f('uScale', scale);
    u.f('uStepHours', stepHours);
    u.f('uOpacity', opacity);
    u.f('uSky', sky ? 1 : 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    this.draw();
  }

  release() {
    const gl = this.gl;
    for (const t of [this.heightTex, this.skyViewTex, ...(this.accum || [])]) if (t) gl.deleteTexture(t);
    this.heightTex = this.skyViewTex = null;
    this.accum = null;
  }
}
