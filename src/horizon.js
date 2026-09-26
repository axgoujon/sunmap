import { sampleBilinear, normalAt } from './terrain.js';

const DEG = Math.PI / 180;
const EARTH_RADIUS = 6371000;
// Standard atmospheric refraction lets a ray bend around the Earth as if the
// planet were 7/6 its true radius.
const EFFECTIVE_RADIUS = (EARTH_RADIUS * 7) / 6;

export const curvatureDrop = (distance) => (distance * distance) / (2 * EFFECTIVE_RADIUS);

/**
 * Horizon elevation angle for each azimuth, seen from one point.
 *
 * Steps grow geometrically: near terrain needs pixel-scale sampling, distant
 * ranges do not, and a linear march to 150 km would cost thousands of samples
 * per ray for no extra accuracy.
 */
export function horizonProfile(hf, px, py, {
  azimuths = 180,
  maxDistance = 150000,
  firstStep = 0.7,
  growth = 1.02,
  observerOffset = 0,
} = {}) {
  const mpp = hf.metresPerPixel;
  const z0 = sampleBilinear(hf, px, py) + observerOffset;
  const profile = new Float32Array(azimuths);

  for (let a = 0; a < azimuths; a++) {
    const bearing = (a * 360) / azimuths;
    const dx = Math.sin(bearing * DEG);
    const dy = -Math.cos(bearing * DEG);

    let maxTan = -Infinity;
    let step = firstStep;
    for (let d = firstStep; d < maxDistance / mpp; d += step, step *= growth) {
      const x = px + dx * d;
      const y = py + dy * d;
      if (x < 0 || y < 0 || x >= hf.width || y >= hf.height) break;
      const metres = d * mpp;
      const dz = sampleBilinear(hf, x, y) - z0 - curvatureDrop(metres);
      const tan = dz / metres;
      if (tan > maxTan) maxTan = tan;
    }
    profile[a] = maxTan === -Infinity ? 0 : Math.atan(maxTan) / DEG;
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
