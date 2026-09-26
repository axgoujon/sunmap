import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { sunPosition, dayOfYear, extraterrestrialIrradiance } from '../src/solar.js';

const cases = JSON.parse(fs.readFileSync(new URL('./fixtures-pysolar.json', import.meta.url)));

test('matches pysolar reference within 0.05 deg', () => {
  for (const c of cases) {
    const r = sunPosition(c.lat, c.lon, new Date(c.iso));
    const dAz = ((r.azimuth - c.az + 540) % 360) - 180;
    assert.ok(Math.abs(r.elevation - c.elev) < 0.05, `${c.iso} elevation off by ${r.elevation - c.elev}`);
    assert.ok(Math.abs(dAz) < 0.05, `${c.iso} azimuth off by ${dAz}`);
  }
});

test('winter solstice noon elevation at Chamonix is ~20.6 deg', () => {
  const r = sunPosition(45.9163, 6.8652, new Date('2026-12-21T11:15:00Z'));
  assert.ok(Math.abs(r.elevation - 20.6) < 0.3);
});

test('azimuth sweeps east to west through the day', () => {
  const az = ['08:00', '10:00', '12:00', '14:00', '16:00'].map(
    (t) => sunPosition(45.9163, 6.8652, new Date(`2026-03-21T${t}:00Z`)).azimuth
  );
  for (let i = 1; i < az.length; i++) assert.ok(az[i] > az[i - 1], `azimuth not increasing: ${az}`);
});

test('refraction lifts the sun near the horizon', () => {
  const r = sunPosition(45.9163, 6.8652, new Date('2026-01-21T07:15:00Z'));
  assert.ok(r.elevation > r.elevationRaw);
  assert.ok(r.elevation - r.elevationRaw > 0.1);
});

test('dayOfYear and solar constant behave', () => {
  assert.equal(Math.floor(dayOfYear(new Date('2026-01-01T12:00:00Z'))), 1);
  const jan = extraterrestrialIrradiance(new Date('2026-01-03T00:00:00Z'));
  const jul = extraterrestrialIrradiance(new Date('2026-07-04T00:00:00Z'));
  assert.ok(jan > jul, 'perihelion in January should exceed aphelion in July');
  assert.ok(jan > 1380 && jan < 1420, `got ${jan}`);
});
