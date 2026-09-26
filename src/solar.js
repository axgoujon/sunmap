const DEG = Math.PI / 180;

const norm360 = (d) => ((d % 360) + 360) % 360;

export function julianCentury(date) {
  return (date.getTime() / 86400000 + 2440587.5 - 2451545) / 36525;
}

function geometry(t) {
  const meanLong = norm360(280.46646 + t * (36000.76983 + t * 0.0003032));
  const meanAnom = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccent = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);

  const centre =
    Math.sin(meanAnom * DEG) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnom * DEG) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnom * DEG) * 0.000289;

  const trueLong = meanLong + centre;
  const omega = 125.04 - 1934.136 * t;
  const appLong = trueLong - 0.00569 - 0.00478 * Math.sin(omega * DEG);

  const meanObliq = 23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliq = meanObliq + 0.00256 * Math.cos(omega * DEG);

  const declination =
    Math.asin(Math.sin(obliq * DEG) * Math.sin(appLong * DEG)) / DEG;

  const varY = Math.tan((obliq / 2) * DEG) ** 2;
  const eqOfTime =
    4 *
    (varY * Math.sin(2 * meanLong * DEG) -
      2 * eccent * Math.sin(meanAnom * DEG) +
      4 * eccent * varY * Math.sin(meanAnom * DEG) * Math.cos(2 * meanLong * DEG) -
      0.5 * varY * varY * Math.sin(4 * meanLong * DEG) -
      1.25 * eccent * eccent * Math.sin(2 * meanAnom * DEG)) /
    DEG;

  return { declination, eqOfTime, eccent, meanAnom };
}

// Bennett refraction, valid down to the horizon. Matters at the low winter sun
// angles that dominate this model.
function refraction(elevation) {
  if (elevation > 85) return 0;
  const te = Math.tan(elevation * DEG);
  if (elevation > 5) return (58.1 / te - 0.07 / te ** 3 + 0.000086 / te ** 5) / 3600;
  if (elevation > -0.575)
    return (
      (1735 + elevation * (-518.2 + elevation * (103.4 + elevation * (-12.79 + elevation * 0.711)))) / 3600
    );
  return -20.772 / te / 3600;
}

export function sunPosition(lat, lon, date) {
  const t = julianCentury(date);
  const { declination, eqOfTime } = geometry(t);

  const minutesUTC =
    date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (minutesUTC + eqOfTime + 4 * lon + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const latR = lat * DEG;
  const decR = declination * DEG;
  const cosZenith =
    Math.sin(latR) * Math.sin(decR) +
    Math.cos(latR) * Math.cos(decR) * Math.cos(hourAngle * DEG);
  const zenith = Math.acos(Math.min(1, Math.max(-1, cosZenith))) / DEG;

  const elevationRaw = 90 - zenith;
  const elevation = elevationRaw + refraction(elevationRaw);

  const denom = Math.cos(latR) * Math.sin(zenith * DEG);
  let azimuth;
  if (Math.abs(denom) < 1e-9) {
    azimuth = declination > lat ? 0 : 180;
  } else {
    const c = Math.min(1, Math.max(-1, (Math.sin(latR) * Math.cos(zenith * DEG) - Math.sin(decR)) / denom));
    azimuth = hourAngle > 0 ? norm360(Math.acos(c) / DEG + 180) : norm360(540 - Math.acos(c) / DEG);
  }

  return { elevation, elevationRaw, azimuth, declination, hourAngle, eqOfTime, zenith };
}

// Earth-Sun distance correction on top-of-atmosphere irradiance.
export function extraterrestrialIrradiance(date) {
  const dayAngle = (2 * Math.PI * dayOfYear(date)) / 365.25;
  return 1361 * (1.00011 + 0.034221 * Math.cos(dayAngle) + 0.00128 * Math.sin(dayAngle) +
    0.000719 * Math.cos(2 * dayAngle) + 0.000077 * Math.sin(2 * dayAngle));
}

export function dayOfYear(date) {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return (date.getTime() - start) / 86400000;
}
