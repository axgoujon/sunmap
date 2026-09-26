import { extraterrestrialIrradiance } from './solar.js';

const DEG = Math.PI / 180;

// Kasten-Young relative air mass, corrected for station pressure. Altitude
// matters strongly in alpine terrain: thinner air passes more direct beam.
export function airMass(sunElevation, altitude = 0) {
  if (sunElevation <= -1) return Infinity;
  const zenith = 90 - Math.max(sunElevation, 0.1);
  const relative = 1 / (Math.cos(zenith * DEG) + 0.50572 * (96.07995 - zenith) ** -1.6364);
  return relative * Math.exp(-altitude / 8434.5);
}

/**
 * Ineichen-Perez clear-sky model. Linke turbidity defaults to clean mountain
 * air; there is no cloud term, so results describe a bluebird day only.
 */
export function clearSky(sunElevation, altitude, date, linkeTurbidity = 2.5) {
  if (sunElevation <= 0) return { ghi: 0, dni: 0, dhi: 0 };

  const i0 = extraterrestrialIrradiance(date);
  const am = airMass(sunElevation, altitude);
  const cosZenith = Math.sin(sunElevation * DEG);

  const fh1 = Math.exp(-altitude / 8000);
  const fh2 = Math.exp(-altitude / 1250);
  const cg1 = 5.09e-5 * altitude + 0.868;
  const cg2 = 3.92e-5 * altitude + 0.0387;

  const ghi = Math.max(0,
    cg1 * i0 * cosZenith * Math.exp(-cg2 * am * (fh1 + fh2 * (linkeTurbidity - 1))) *
    Math.exp(0.01 * am ** 1.8));

  const dni = Math.max(0, Math.min(
    (0.664 + 0.163 / fh1) * i0 * Math.exp(-0.09 * am * (linkeTurbidity - 1)),
    ghi / Math.max(cosZenith, 1e-6)));

  return { ghi, dni, dhi: Math.max(0, ghi - dni * cosZenith) };
}

/**
 * Irradiance on a terrain surface, in W/m^2.
 *
 * `beam` already folds together terrain shadowing and the cosine of incidence.
 * The reflected term treats whatever blocks the sky as a diffuse reflector,
 * which is crude but not negligible over snow, where albedo reaches 0.8.
 */
export function surfaceIrradiance({ dni, dhi, ghi }, beam, skyView, slope = 0, albedo = 0.6) {
  const direct = dni * Math.max(0, beam);
  const tiltFactor = (1 + Math.cos(slope * DEG)) / 2;
  const diffuse = dhi * skyView * tiltFactor;
  const reflected = ghi * albedo * Math.max(0, 1 - skyView * tiltFactor);
  return { direct, diffuse, reflected, total: direct + diffuse + reflected };
}

/** Trapezoidal integration of W/m^2 samples into Wh/m^2. */
export function integrate(samples, stepMinutes) {
  if (samples.length < 2) return 0;
  let sum = 0;
  for (let i = 1; i < samples.length; i++) sum += (samples[i] + samples[i - 1]) / 2;
  return (sum * stepMinutes) / 60;
}
