import { sampleBilinear, normalAt } from './terrain.js';
import { TILE_SIZE } from './tiles.js';

const DEG = Math.PI / 180;
const EARTH_RADIUS = 6371000;
// Standard atmospheric refraction lets a ray bend around the Earth as if the
// planet were 7/6 its true radius.
const EFFECTIVE_RADIUS = (EARTH_RADIUS * 7) / 6;

export const curvatureDrop = (distance) => (distance * distance) / (2 * EFFECTIVE_RADIUS);

/**
 * Maps near-field texel coordinates to far-field ones. Both mosaics are in
 * Web Mercator pixel space at their own zoom; sampleBilinear indexes texel
 * centres, hence the half-pixel shifts.
 */
export function farMapping(hf, far) {
  const s = 2 ** (far.z - hf.z);
  const ox = (hf.originX * TILE_SIZE + 0.5) * s - far.originX * TILE_SIZE - 0.5;
  const oy = (hf.originY * TILE_SIZE + 0.5) * s - far.originY * TILE_SIZE - 0.5;
  return (x, y) => [x * s + ox, y * s + oy];
}

/** Terrain height under a ray: near field while over it, far field beyond. */
function terrainSampler(hf, far) {
  const toFar = far ? farMapping(hf, far) : null;
  return (x, y) => {
    if (x >= 0 && y >= 0 && x <= hf.width - 1 && y <= hf.height - 1) return sampleBilinear(hf, x, y);
    if (!toFar) return null;
    const [fx, fy] = toFar(x, y);
    if (fx < 0 || fy < 0 || fx > far.width - 1 || fy > far.height - 1) return null;
    return sampleBilinear(far, fx, fy);
  };
}

export function maxHeight(...fields) {
  let hi = -Infinity;
  for (const f of fields) if (f) for (const v of f.data) if (v > hi) hi = v;
  return hi;
}

/**
 * Horizon elevation angle for each azimuth, seen from one point.
 *
 * Steps grow geometrically: near terrain needs pixel-scale sampling, distant
 * ranges do not. Rays leaving the near field continue over `far`, and stop
 * as soon as even the highest terrain could no longer raise the horizon.
 */
export function horizonProfile(hf, px, py, {
  azimuths = 180,
  maxDistance = 150000,
  firstStep = 0.7,
  growth = 1.02,
  observerOffset = 0,
  far = null,
  highest = maxHeight(hf, far),
} = {}) {
  const mpp = hf.metresPerPixel;
  const z0 = sampleBilinear(hf, px, py) + observerOffset;
  const terrain = terrainSampler(hf, far);
  const profile = new Float32Array(azimuths);

  for (let a = 0; a < azimuths; a++) {
    const bearing = (a * 360) / azimuths;
    const dx = Math.sin(bearing * DEG);
    const dy = -Math.cos(bearing * DEG);

    let best = -Infinity;
    let step = firstStep * mpp;
    for (let m = step; m < maxDistance; m += step, step *= growth) {
      if ((highest - z0) / m <= best) break;
      const h = terrain(px + (dx * m) / mpp, py + (dy * m) / mpp);
      if (h === null) break;
      const tan = (h - curvatureDrop(m) - z0) / m;
      if (tan > best) best = tan;
    }
    profile[a] = best === -Infinity ? 0 : Math.atan(best) / DEG;
  }
  return profile;
}

export function horizonAt(profile, azimuth) {
  const n = profile.length;
  const t = (((azimuth % 360) + 360) % 360) * (n / 360);
  const i = Math.floor(t);
  const f = t - i;
  return profile[i % n] * (1 - f) + profile[(i + 1) % n] * f;
}

/**
 * Sky view factor for a horizontal surface: the isotropic-sky irradiance
 * fraction left after terrain blocks part of the hemisphere. Integrating
 * L*cos(theta) over the visible cap gives cos^2(horizon) per azimuth.
 */
export function skyViewFactor(profile) {
  let sum = 0;
  for (const h of profile) {
    const c = Math.cos(Math.max(0, h) * DEG);
    sum += c * c;
  }
  return sum / profile.length;
}

/** Cosine of the angle between the sun and the surface normal. */
export function incidence(normal, sunElevation, sunAzimuth) {
  const el = sunElevation * DEG;
  const az = sunAzimuth * DEG;
  const sx = Math.cos(el) * Math.sin(az);
  const sy = -Math.cos(el) * Math.cos(az);
  const sz = Math.sin(el);
  return normal.x * sx + normal.y * sy + normal.z * sz;
}

/**
 * Direct beam reaches the surface only if the sun clears the terrain horizon
 * AND the slope faces it. The second condition dominates in ski terrain: a
 * north face in midwinter is dark even under a clear sky and a high sun.
 */
export function directBeamFactor(hf, px, py, profile, sunElevation, sunAzimuth) {
  if (sunElevation <= 0) return 0;
  if (sunElevation <= horizonAt(profile, sunAzimuth)) return 0;
  return Math.max(0, incidence(normalAt(hf, px, py), sunElevation, sunAzimuth));
}
