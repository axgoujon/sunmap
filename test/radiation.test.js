import { test } from 'node:test';
import assert from 'node:assert/strict';
import { airMass, clearSky, surfaceIrradiance, integrate } from '../src/radiation.js';

const JUNE = new Date('2026-06-21T12:00:00Z');
const DEC = new Date('2026-12-21T12:00:00Z');

test('air mass is 1 at the zenith and grows toward the horizon', () => {
  assert.ok(Math.abs(airMass(90, 0) - 1) < 0.01);
  assert.ok(Math.abs(airMass(30, 0) - 2) < 0.05);
  let prev = 0;
  for (const el of [90, 60, 30, 20, 10, 5]) {
    const am = airMass(el, 0);
    assert.ok(am > prev, `air mass should increase as the sun drops: ${el}`);
    prev = am;
  }
});

test('altitude thins the air column', () => {
  assert.ok(airMass(30, 3800) < airMass(30, 0));
  assert.ok(Math.abs(airMass(30, 3800) - 1.27) < 0.05);
});

test('no irradiance below the horizon', () => {
  for (const el of [0, -1, -10]) {
    const c = clearSky(el, 2000, DEC);
    assert.equal(c.ghi, 0);
    assert.equal(c.dni, 0);
    assert.equal(c.dhi, 0);
  }
});

test('clear-sky components are self-consistent', () => {
  for (const el of [10, 30, 60, 85]) {
    const c = clearSky(el, 1500, JUNE);
    const reconstructed = c.dni * Math.sin((el * Math.PI) / 180) + c.dhi;
    assert.ok(Math.abs(reconstructed - c.ghi) < 1, `GHI mismatch at ${el}: ${reconstructed} vs ${c.ghi}`);
    assert.ok(c.dni > 0 && c.dhi >= 0 && c.ghi > 0);
  }
});

test('irradiance stays within physical bounds', () => {
  const c = clearSky(90, 0, JUNE);
  assert.ok(c.ghi > 900 && c.ghi < 1150, `got ${c.ghi}`);
  assert.ok(c.dni > 850 && c.dni < 1100, `got ${c.dni}`);
});

test('a high station receives more direct beam than a valley', () => {
  const valley = clearSky(45, 1035, JUNE);
  const summit = clearSky(45, 3842, JUNE);
  assert.ok(summit.dni > valley.dni, `${summit.dni} vs ${valley.dni}`);
});

test('winter south face far outperforms a north face', () => {
  const c = clearSky(20, 2000, DEC);
  const south = surfaceIrradiance(c, 0.94, 0.9, 30, 0.7).total;
  const north = surfaceIrradiance(c, 0, 0.85, 30, 0.7).total;
  assert.ok(south / north > 5, `ratio only ${south / north}`);
  assert.ok(north > 0, 'a shaded face still receives diffuse and reflected light');
});

test('shadowed ground receives no direct beam', () => {
  const c = clearSky(40, 2000, JUNE);
  assert.equal(surfaceIrradiance(c, 0, 0.9, 20).direct, 0);
});

test('trapezoidal integration converts W/m^2 to Wh/m^2', () => {
  assert.equal(integrate([100, 100, 100], 60), 200);
  assert.equal(integrate([0, 100], 60), 50);
  assert.equal(integrate([500], 60), 0);
  assert.ok(Math.abs(integrate(new Array(13).fill(1000), 60) - 12000) < 1e-6);
});
