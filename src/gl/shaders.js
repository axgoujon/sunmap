// Coordinates used throughout:
//   terrain px  - pixels of the near heightfield; texel i is centred on i + 0.5
//   output px   - pixels of what is drawn; uOut output px per terrain px, so a
//                 30 m source can still yield sharp shadow edges
//   far px      - pixels of the coarse far-field heightfield that lets rays
//                 leaving the near field keep finding distant ridges

const SAMPLING = `
uniform sampler2D uHeight;
uniform vec2 uSize;
uniform int uMaxLevel;
uniform float uMpp;
uniform float uOut;

#ifdef MANUAL_BILINEAR
// Devices without OES_texture_float_linear cannot filter float textures, so
// the four neighbours are fetched and blended here. Level selection mirrors
// the hardware's MIPMAP_NEAREST rounding so both paths agree.
float sampleTex(sampler2D tex, vec2 p, vec2 size, float lod, int maxLevel) {
  int level = clamp(int(floor(lod + 0.5)), 0, maxLevel);
  ivec2 lsize = textureSize(tex, level);
  // Coarser levels hold the maximum over a whole block, which already bounds
  // anything a blend could return, so one fetch does; only level 0 blends.
  if (level > 0) return texelFetch(tex, clamp(ivec2((p / size) * vec2(lsize)), ivec2(0), lsize - 1), level).r;
  vec2 q = (p / size) * vec2(lsize) - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = q - floor(q);
  ivec2 hi = lsize - 1;
  float a = texelFetch(tex, clamp(i, ivec2(0), hi), level).r;
  float b = texelFetch(tex, clamp(i + ivec2(1, 0), ivec2(0), hi), level).r;
  float c = texelFetch(tex, clamp(i + ivec2(0, 1), ivec2(0), hi), level).r;
  float d = texelFetch(tex, clamp(i + ivec2(1, 1), ivec2(0), hi), level).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
#else
float sampleTex(sampler2D tex, vec2 p, vec2 size, float lod, int maxLevel) {
  return textureLod(tex, p / size, lod).r;
}
#endif

float nearHeight(vec2 p) { return sampleTex(uHeight, p, uSize, 0.0, uMaxLevel); }

vec3 surfaceNormal(vec2 p) {
  float dzdx = (nearHeight(p + vec2(1.0, 0.0)) - nearHeight(p - vec2(1.0, 0.0))) / (2.0 * uMpp);
  float dzdy = (nearHeight(p + vec2(0.0, 1.0)) - nearHeight(p - vec2(0.0, 1.0))) / (2.0 * uMpp);
  return normalize(vec3(-dzdx, -dzdy, 1.0));
}
`;

const MARCH = `
const float EFFECTIVE_RADIUS = 6371000.0 * 7.0 / 6.0;
const float PI = 3.141592653589793;

uniform sampler2D uFar;
uniform vec2 uFarSize;
uniform int uFarMaxLevel;
uniform float uFarMpp;
uniform float uFarScale;   // far px = terrain px * uFarScale + uFarOffset
uniform vec2 uFarOffset;
uniform float uMaxDist;    // metres
uniform float uFirstStep;  // metres
uniform float uGrowth;
uniform float uLodBias;
uniform float uMaxHeight;  // highest terrain anywhere in either field

// Terrain under the ray: the near field while the ray is over it, the far
// field beyond. Each sample comes from the mip level matching the step, and
// the pyramids store maxima, so long steps cannot tunnel through a ridge.
bool terrainAt(vec2 p, float stepMetres, out float h) {
  if (all(greaterThanEqual(p, vec2(0.5))) && all(lessThan(p, uSize - 0.5))) {
    h = sampleTex(uHeight, p, uSize, max(0.0, log2(stepMetres / uMpp) + uLodBias), uMaxLevel);
    return true;
  }
  vec2 q = p * uFarScale + uFarOffset;
  if (any(lessThan(q, vec2(0.5))) || any(greaterThanEqual(q, uFarSize - 0.5))) return false;
  h = sampleTex(uFar, q, uFarSize, max(0.0, log2(stepMetres / uFarMpp) + uLodBias), uFarMaxLevel);
  return true;
}

float curvature(float m) { return m * m / (2.0 * EFFECTIVE_RADIUS); }

bool blocked(vec2 p0, float z0, vec2 dir, float tanEl) {
  float m = uFirstStep;
  float step = uFirstStep;
  for (int i = 0; i < 700; i++) {
    if (m > uMaxDist) break;
    float ray = z0 + m * tanEl;
    // Once the ray is above the highest terrain anywhere, nothing further can
    // block it (the heuristic from the first version of this project).
    if (ray > uMaxHeight) break;
    float h;
    if (!terrainAt(p0 + dir * (m / uMpp), step, h)) break;
    if (h - curvature(m) > ray) return true;
    m += step;
    step *= uGrowth;
  }
  return false;
}

float horizonTangent(vec2 p0, float z0, vec2 dir) {
  float m = uFirstStep;
  float step = uFirstStep;
  float best = -1e9;
  for (int i = 0; i < 700; i++) {
    if (m > uMaxDist) break;
    // Even the highest terrain could not beat the best angle from here on.
    if ((uMaxHeight - z0) / m <= best) break;
    float h;
    if (!terrainAt(p0 + dir * (m / uMpp), step, h)) break;
    best = max(best, (h - curvature(m) - z0) / m);
    m += step;
    step *= uGrowth;
  }
  return best;
}
`;

export const MAX_REDUCE_FS = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform int uLevel;
out vec4 fragColor;
void main() {
  ivec2 dst = ivec2(gl_FragCoord.xy);
  ivec2 src = dst * 2;
  ivec2 lim = textureSize(uSource, uLevel) - 1;
  float a = texelFetch(uSource, min(src, lim), uLevel).r;
  float b = texelFetch(uSource, min(src + ivec2(1, 0), lim), uLevel).r;
  float c = texelFetch(uSource, min(src + ivec2(0, 1), lim), uLevel).r;
  float d = texelFetch(uSource, min(src + ivec2(1, 1), lim), uLevel).r;
  fragColor = vec4(max(max(a, b), max(c, d)), 0.0, 0.0, 1.0);
}`;

// Sky view varies smoothly, so it is computed on a grid uSkyScale times
// coarser than the terrain: the most expensive pass (16 rays per texel) runs
// on a quarter of the texels.
export const SKYVIEW_FS = `#version 300 es
precision highp float;
${SAMPLING}
${MARCH}
uniform int uAzimuths;
uniform float uSkyScale;
out vec4 fragColor;
void main() {
  vec2 p0 = gl_FragCoord.xy * uSkyScale;
  float z0 = nearHeight(p0);
  float sum = 0.0;
  for (int a = 0; a < 32; a++) {
    if (a >= uAzimuths) break;
    float bearing = float(a) * 2.0 * PI / float(uAzimuths);
    float h = atan(max(horizonTangent(p0, z0, vec2(sin(bearing), -cos(bearing))), 0.0));
    float c = cos(h);
    sum += c * c;
  }
  fragColor = vec4(sum / float(uAzimuths), 0.0, 0.0, 1.0);
}`;

// One instant, added to (or with uWeight = -1 removed from) the running sum.
//   r = direct W/m^2,  g = diffuse + reflected W/m^2,  b = lit flag,  a = samples
export const IRRADIANCE_FS = `#version 300 es
precision highp float;
${SAMPLING}
${MARCH}
uniform sampler2D uSkyView;
uniform float uSkyScale;
uniform sampler2D uPrevious;
uniform float uSunAz;
uniform float uSunEl;
uniform vec3 uDni;   // x at the low altitude, y at the high altitude
uniform vec3 uDhi;
uniform vec3 uGhi;
uniform vec2 uAltRange;
uniform float uAlbedo;
uniform float uWeight;
out vec4 fragColor;

// The clear-sky model varies smoothly with altitude, so evaluating it at the
// field's two extremes and interpolating avoids treating a 4800 m summit like
// the valley floor 3800 m below it.
float atAltitude(vec3 pair, float z) {
  float t = clamp((z - uAltRange.x) / max(uAltRange.y - uAltRange.x, 1.0), 0.0, 1.0);
  return mix(pair.x, pair.y, t);
}

void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 p0 = gl_FragCoord.xy / uOut;
  float z0 = nearHeight(p0);

  float svf = texelFetch(uSkyView, clamp(ivec2(p0 / uSkyScale), ivec2(0), textureSize(uSkyView, 0) - 1), 0).r;
  vec3 n = surfaceNormal(p0);
  float tilt = (1.0 + n.z) * 0.5;

  float direct = 0.0;
  float lit = 0.0;
  if (uSunEl > 0.0) {
    float el = radians(uSunEl);
    float az = radians(uSunAz);
    vec3 s = vec3(cos(el) * sin(az), -cos(el) * cos(az), sin(el));
    float cosInc = dot(n, s);
    if (cosInc > 0.0 && !blocked(p0, z0, vec2(sin(az), -cos(az)), tan(el))) {
      direct = atAltitude(uDni, z0) * cosInc;
      lit = 1.0;
    }
  }

  float diffuse = atAltitude(uDhi, z0) * svf * tilt;
  float reflected = atAltitude(uGhi, z0) * uAlbedo * max(0.0, 1.0 - svf * tilt);
  fragColor = texelFetch(uPrevious, ip, 0) + uWeight * vec4(direct, diffuse + reflected, lit, 1.0);
}`;

export const COLORIZE_FS = `#version 300 es
precision highp float;
${SAMPLING}
uniform sampler2D uAccum;
uniform vec2 uOutSize;
uniform int uMode;        // 0 binary, 1 instant power, 2 cumulated energy, 3 sun hours, 4 slope
uniform float uScale;
uniform float uStepHours;
uniform float uOpacity;
uniform float uSky;       // 1 adds sky light (diffuse + reflected) to direct sun, 0 leaves it out
out vec4 fragColor;

vec3 inferno(float t) {
  const vec3 c[11] = vec3[11](
    vec3(0.001, 0.000, 0.014), vec3(0.088, 0.035, 0.199), vec3(0.226, 0.037, 0.376),
    vec3(0.374, 0.076, 0.432), vec3(0.519, 0.132, 0.420), vec3(0.666, 0.190, 0.371),
    vec3(0.797, 0.270, 0.292), vec3(0.902, 0.381, 0.188), vec3(0.969, 0.531, 0.070),
    vec3(0.988, 0.710, 0.106), vec3(0.988, 0.998, 0.645)
  );
  float x = clamp(t, 0.0, 1.0) * 10.0;
  int i = int(floor(x));
  return mix(c[min(i, 10)], c[min(i + 1, 10)], fract(x));
}

vec3 slopeRamp(float deg) {
  if (deg < 25.0) return vec3(0.35, 0.65, 0.40);
  if (deg < 30.0) return vec3(0.95, 0.85, 0.30);
  if (deg < 35.0) return vec3(0.95, 0.55, 0.20);
  if (deg < 40.0) return vec3(0.85, 0.20, 0.20);
  if (deg < 45.0) return vec3(0.65, 0.15, 0.55);
  return vec3(0.25, 0.15, 0.45);
}

void main() {
  // gl_FragCoord counts from the bottom of the drawing buffer, but the canvas
  // is composited onto the map as an image, whose first row is the top. Row 0
  // of the heightfield is the northern edge, so the rows are mirrored here.
  // gl_FragCoord sits at pixel centres (row + 0.5), so H - y lands exactly on
  // the mirrored row; H - 1 - y would truncate one row short.
  vec2 flipped = vec2(gl_FragCoord.x, uOutSize.y - gl_FragCoord.y);
  ivec2 ip = ivec2(flipped);
  vec4 acc = texelFetch(uAccum, ip, 0);
  float samples = max(acc.a, 1.0);

  if (uMode == 0) {
    float lit = acc.b / samples;
    fragColor = vec4(vec3(1.0, 0.85, 0.35) * lit, (1.0 - lit) * uOpacity * 0.85);
    if (lit > 0.5) fragColor = vec4(1.0, 0.88, 0.45, uOpacity * 0.30);
    return;
  }
  if (uMode == 1) {
    fragColor = vec4(inferno((acc.r + uSky * acc.g) / uScale), uOpacity);
    return;
  }
  if (uMode == 2) {
    float wh = (acc.r + uSky * acc.g) * uStepHours;
    fragColor = vec4(inferno(wh / uScale), uOpacity);
    return;
  }
  if (uMode == 3) {
    fragColor = vec4(inferno(acc.b * uStepHours / uScale), uOpacity);
    return;
  }
  vec3 n = surfaceNormal((vec2(ip) + 0.5) / uOut);
  float deg = degrees(acos(clamp(n.z, -1.0, 1.0)));
  fragColor = vec4(slopeRamp(deg), deg < 25.0 ? uOpacity * 0.35 : uOpacity);
}`;
