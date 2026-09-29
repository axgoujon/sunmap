const COMMON = `
const float EFFECTIVE_RADIUS = 6371000.0 * 7.0 / 6.0;
const float PI = 3.141592653589793;

uniform sampler2D uHeight;
uniform vec2 uSize;
uniform float uMpp;
uniform float uMaxDistPx;
uniform float uFirstStep;
uniform float uGrowth;
uniform float uLodBias;
uniform int uMaxLevel;

float heightAt(ivec2 p) {
  return texelFetch(uHeight, clamp(p, ivec2(0), ivec2(uSize) - 1), 0).r;
}

#ifdef MANUAL_BILINEAR
// Devices without OES_texture_float_linear cannot filter float textures, so
// the four neighbours are fetched and blended here. Level selection mirrors
// the hardware's MIPMAP_NEAREST rounding so both paths give the same answer.
float sampleHeight(vec2 p, float lod) {
  int level = clamp(int(floor(lod + 0.5)), 0, uMaxLevel);
  ivec2 size = textureSize(uHeight, level);
  vec2 q = (p / uSize) * vec2(size) - 0.5;
  ivec2 i = ivec2(floor(q));
  vec2 f = q - floor(q);
  ivec2 hi = size - 1;
  float a = texelFetch(uHeight, clamp(i, ivec2(0), hi), level).r;
  float b = texelFetch(uHeight, clamp(i + ivec2(1, 0), ivec2(0), hi), level).r;
  float c = texelFetch(uHeight, clamp(i + ivec2(0, 1), ivec2(0), hi), level).r;
  float d = texelFetch(uHeight, clamp(i + ivec2(1, 1), ivec2(0), hi), level).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
#else
float sampleHeight(vec2 p, float lod) {
  return textureLod(uHeight, p / uSize, lod).r;
}
#endif

// Steps grow geometrically, and each sample is taken from the mip level whose
// footprint matches the step. Because the pyramid stores maxima, a long
// far-field step cannot tunnel through a thin ridge.
float horizonTangent(vec2 p0, float z0, vec2 dir) {
  float d = uFirstStep;
  float step = uFirstStep;
  float best = -1e9;
  for (int i = 0; i < 512; i++) {
    if (d > uMaxDistPx) break;
    vec2 p = p0 + dir * d;
    if (p.x < 0.0 || p.y < 0.0 || p.x >= uSize.x || p.y >= uSize.y) break;
    float lod = max(0.0, log2(step) + uLodBias);
    float h = sampleHeight(p, lod);
    float m = d * uMpp;
    best = max(best, (h - (m * m) / (2.0 * EFFECTIVE_RADIUS) - z0) / m);
    d += step;
    step *= uGrowth;
  }
  return best;
}

bool blocked(vec2 p0, float z0, vec2 dir, float tanEl) {
  float d = uFirstStep;
  float step = uFirstStep;
  for (int i = 0; i < 512; i++) {
    if (d > uMaxDistPx) break;
    vec2 p = p0 + dir * d;
    if (p.x < 0.0 || p.y < 0.0 || p.x >= uSize.x || p.y >= uSize.y) break;
    float lod = max(0.0, log2(step) + uLodBias);
    float h = sampleHeight(p, lod);
    float m = d * uMpp;
    if (h - (m * m) / (2.0 * EFFECTIVE_RADIUS) > z0 + m * tanEl) return true;
    d += step;
    step *= uGrowth;
  }
  return false;
}

vec3 surfaceNormal(ivec2 p) {
  float dzdx = (heightAt(p + ivec2(1, 0)) - heightAt(p - ivec2(1, 0))) / (2.0 * uMpp);
  float dzdy = (heightAt(p + ivec2(0, 1)) - heightAt(p - ivec2(0, 1))) / (2.0 * uMpp);
  return normalize(vec3(-dzdx, -dzdy, 1.0));
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

export const SKYVIEW_FS = `#version 300 es
precision highp float;
${COMMON}
uniform int uAzimuths;
out vec4 fragColor;
void main() {
  ivec2 ip = ivec2(gl_FragCoord.xy);
  vec2 p0 = gl_FragCoord.xy;
  float z0 = heightAt(ip);
  float sum = 0.0;
  for (int a = 0; a < 32; a++) {
    if (a >= uAzimuths) break;
    float bearing = float(a) * 2.0 * PI / float(uAzimuths);
    vec2 dir = vec2(sin(bearing), -cos(bearing));
    float t = horizonTangent(p0, z0, dir);
    float h = atan(max(t, 0.0));
    float c = cos(h);
    sum += c * c;
  }
  fragColor = vec4(sum / float(uAzimuths), 0.0, 0.0, 1.0);
}`;

// One timestep, additively blended into the accumulator.
//   r = direct W/m^2,  g = diffuse + reflected W/m^2,  b = lit flag,  a = samples
export const IRRADIANCE_FS = `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D uSkyView;
uniform sampler2D uPrevious;
uniform float uSunAz;
uniform float uSunEl;
uniform vec3 uDni;   // x at the low altitude, y at the high altitude
uniform vec3 uDhi;
uniform vec3 uGhi;
uniform vec2 uAltRange;
uniform float uAlbedo;
uniform float uWeight;   // +1 adds this instant to the running sum, -1 removes it
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
  vec2 p0 = gl_FragCoord.xy;
  float z0 = heightAt(ip);

  float dni = atAltitude(uDni, z0);
  float dhi = atAltitude(uDhi, z0);
  float ghi = atAltitude(uGhi, z0);

  float svf = texelFetch(uSkyView, ip, 0).r;
  vec3 n = surfaceNormal(ip);
  float slope = acos(clamp(n.z, -1.0, 1.0));
  float tilt = (1.0 + cos(slope)) * 0.5;

  float direct = 0.0;
  float lit = 0.0;
  if (uSunEl > 0.0) {
    float el = radians(uSunEl);
    float az = radians(uSunAz);
    vec3 s = vec3(cos(el) * sin(az), -cos(el) * cos(az), sin(el));
    float cosInc = dot(n, s);
    if (cosInc > 0.0 && !blocked(p0, z0, vec2(sin(az), -cos(az)), tan(el))) {
      direct = dni * cosInc;
      lit = 1.0;
    }
  }

  float diffuse = dhi * svf * tilt;
  float reflected = ghi * uAlbedo * max(0.0, 1.0 - svf * tilt);
  fragColor = texelFetch(uPrevious, ip, 0) + uWeight * vec4(direct, diffuse + reflected, lit, 1.0);
}`;

export const COLORIZE_FS = `#version 300 es
precision highp float;
uniform sampler2D uAccum;
uniform sampler2D uHeight;
uniform vec2 uSize;
uniform int uMode;        // 0 binary, 1 instant power, 2 cumulated energy, 3 sun hours, 4 slope
uniform float uScale;
uniform float uStepHours;
uniform float uMpp;
uniform float uOpacity;
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
  // of the heightfield is the northern edge, so without this flip the overlay
  // is drawn mirrored about the equator of its own bounding box.
  // gl_FragCoord sits at pixel centres (row + 0.5), so H - y lands exactly on
  // the mirrored row; H - 1 - y would truncate one row short.
  ivec2 ip = ivec2(gl_FragCoord.x, uSize.y - gl_FragCoord.y);
  vec4 acc = texelFetch(uAccum, ip, 0);
  float samples = max(acc.a, 1.0);

  if (uMode == 0) {
    float lit = acc.b / samples;
    fragColor = vec4(vec3(1.0, 0.85, 0.35) * lit, (1.0 - lit) * uOpacity * 0.85);
    if (lit > 0.5) fragColor = vec4(1.0, 0.88, 0.45, uOpacity * 0.30);
    return;
  }
  if (uMode == 1) {
    fragColor = vec4(inferno((acc.r + acc.g) / uScale), uOpacity);
    return;
  }
  if (uMode == 2) {
    float wh = (acc.r + acc.g) * uStepHours;
    fragColor = vec4(inferno(wh / uScale), uOpacity);
    return;
  }
  if (uMode == 3) {
    fragColor = vec4(inferno(acc.b * uStepHours / uScale), uOpacity);
    return;
  }
  float dzdx = (texelFetch(uHeight, clamp(ip + ivec2(1, 0), ivec2(0), ivec2(uSize) - 1), 0).r
              - texelFetch(uHeight, clamp(ip - ivec2(1, 0), ivec2(0), ivec2(uSize) - 1), 0).r) / (2.0 * uMpp);
  float dzdy = (texelFetch(uHeight, clamp(ip + ivec2(0, 1), ivec2(0), ivec2(uSize) - 1), 0).r
              - texelFetch(uHeight, clamp(ip - ivec2(0, 1), ivec2(0), ivec2(uSize) - 1), 0).r) / (2.0 * uMpp);
  float deg = degrees(atan(length(vec2(dzdx, dzdy))));
  fragColor = vec4(slopeRamp(deg), deg < 25.0 ? uOpacity * 0.35 : uOpacity);
}`;
