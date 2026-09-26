import { test } from 'node:test';
import assert from 'node:assert/strict';
import { horizonProfile, horizonAt, skyViewFactor, curvatureDrop, incidence } from '../src/horizon.js';
import { normalAt } from '../src/terrain.js';

const flat = (size, mpp, h = 1000) => ({
  data: new Float32Array(size * size).fill(h),
  width: size, height: size, metresPerPixel: mpp,
});

test('flat terrain has a horizon at roughly zero, dipping below with distance', () => {
  const hf = flat(400, 30);
  const p = horizonProfile(hf, 200, 200, { azimuths: 8 });
  for (const h of p) assert.ok(h <= 0 && h > -0.5, `got ${h}`);
});

test('a wall produces the geometrically correct horizon angle', () => {
  const size = 400, mpp = 30, base = 1000, wallHeight = 600, wallPx = 100;
  const hf = flat(size, mpp, base);
  for (let y = 0; y < size; y++)
    for (let x = wallPx + 200; x < wallPx + 205; x++) hf.data[y * size + x] = base + wallHeight;

  const p = horizonProfile(hf, 200, 200, { azimuths: 360 });
  const distance = wallPx * mpp;
  const expected = (Math.atan((wallHeight - curvatureDrop(distance)) / distance) * 180) / Math.PI;
  assert.ok(Math.abs(horizonAt(p, 90) - expected) < 0.5, `east: got ${horizonAt(p, 90)}, expected ${expected}`);
  assert.ok(horizonAt(p, 270) <= 0, `west should be clear, got ${horizonAt(p, 270)}`);
});

test('curvature drop matches d^2/2R with refraction', () => {
  assert.ok(Math.abs(curvatureDrop(100000) - 673) < 5);
  assert.ok(Math.abs(curvatureDrop(20000) - 27) < 2);
  assert.equal(curvatureDrop(0), 0);
});

test('sky view factor is 1 on open flat ground and falls when enclosed', () => {
  assert.ok(Math.abs(skyViewFactor(new Float32Array(180)) - 1) < 1e-9);
  const enclosed = new Float32Array(180).fill(60);
  assert.ok(Math.abs(skyViewFactor(enclosed) - 0.25) < 1e-6);
  const walled = new Float32Array(180).fill(90);
  assert.ok(Math.abs(skyViewFactor(walled)) < 1e-9);
});

test('horizonAt interpolates and wraps around north', () => {
  const p = new Float32Array([0, 10, 20, 30]);
  assert.ok(Math.abs(horizonAt(p, 0) - 0) < 1e-9);
  assert.ok(Math.abs(horizonAt(p, 90) - 10) < 1e-9);
  assert.ok(Math.abs(horizonAt(p, 45) - 5) < 1e-9);
  assert.ok(Math.abs(horizonAt(p, 360) - horizonAt(p, 0)) < 1e-9);
  assert.ok(Math.abs(horizonAt(p, 315) - 15) < 1e-9);
});

test('incidence peaks when the sun is normal to the slope', () => {
  const flatNormal = { x: 0, y: 0, z: 1 };
  assert.ok(Math.abs(incidence(flatNormal, 90, 180) - 1) < 1e-9);
  assert.ok(Math.abs(incidence(flatNormal, 30, 180) - 0.5) < 1e-9);
  assert.ok(Math.abs(incidence(flatNormal, 0, 180)) < 1e-9);
});

test('a south face outperforms a north face under a low winter sun', () => {
  const size = 9, mpp = 100;
  const south = { data: new Float32Array(size * size), width: size, height: size, metresPerPixel: mpp };
  const north = { data: new Float32Array(size * size), width: size, height: size, metresPerPixel: mpp };
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    south.data[y * size + x] = 2000 - y * 60;
    north.data[y * size + x] = 2000 + y * 60;
  }
  const sun = { el: 20, az: 180 };
  const s = incidence(normalAt(south, 4, 4), sun.el, sun.az);
  const n = incidence(normalAt(north, 4, 4), sun.el, sun.az);
  assert.ok(s > 0.55, `south face incidence ${s}`);
  assert.ok(n < 0, `north face should be self-shaded, got ${n}`);
});
