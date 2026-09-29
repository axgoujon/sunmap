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

// --- far field -------------------------------------------------------------

import { farMapping, maxHeight } from '../src/horizon.js';
import { lonToTileX, latToTileY, tileXToLon, tileYToLat, metersPerPixel } from '../src/tiles.js';

const grid = (size, z, originX, originY, f) => {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = f(x, y);
  return { data, width: size, height: size, z, originX, originY, metresPerPixel: metersPerPixel(45.9, z) };
};

test('near-to-far mapping agrees with Mercator geometry', () => {
  const near = grid(4, 12, 2126, 1459, () => 0);
  const far = grid(4, 9, 265, 182, () => 0);
  const toFar = farMapping(near, far);
  for (const [x, y] of [[0, 0], [100.25, 37.5], [511, 700]]) {
    const lon = tileXToLon((near.originX * 256 + x + 0.5) / 256, 12);
    const lat = tileYToLat((near.originY * 256 + y + 0.5) / 256, 12);
    const [fx, fy] = toFar(x, y);
    assert.ok(Math.abs(fx - (lonToTileX(lon, 9) * 256 - far.originX * 256 - 0.5)) < 1e-6);
    assert.ok(Math.abs(fy - (latToTileY(lat, 9) * 256 - far.originY * 256 - 0.5)) < 1e-6);
  }
});

test('a ridge beyond the near field still raises the horizon', () => {
  // Near field: 64 px of flat ground at z12 (~27 m px, ~1.7 km across).
  const near = grid(64, 12, 2126 * 4, 1459 * 4, () => 1000);
  near.z = 14; near.metresPerPixel = metersPerPixel(45.9, 14);
  // Far field with a 1500 m wall 8 km east of centre, well beyond the near field.
  const farZ = 11, farSize = 512;   // 53 m px, ~27 km across
  const nearCentreX = near.originX * 256 + 32, nearCentreY = near.originY * 256 + 32;
  const s = 2 ** (farZ - near.z);
  // Centre the far grid on the near field (fractional tile origins are fine for the mapping).
  const farOriginX = (nearCentreX * s - farSize / 2) / 256, farOriginY = (nearCentreY * s - farSize / 2) / 256;
  const far = grid(farSize, farZ, farOriginX, farOriginY, () => 1000);
  const toFar = farMapping(near, far);
  const [cx, cy] = toFar(32, 32);
  const wallPx = Math.round(cx + 8000 / metersPerPixel(45.9, farZ));
  for (let y = 0; y < farSize; y++) for (let x = wallPx; x < wallPx + 20; x++) far.data[y * farSize + x] = 2500;

  const without = horizonProfile(near, 32, 32, { azimuths: 360 });
  const withFar = horizonProfile(near, 32, 32, { azimuths: 360, far });
  const expected = (Math.atan((1500 - curvatureDrop(8000)) / 8000) * 180) / Math.PI;
  assert.ok(horizonAt(without, 90) <= 0, `near field alone cannot see it: ${horizonAt(without, 90)}`);
  assert.ok(Math.abs(horizonAt(withFar, 90) - expected) < 0.6, `east ${horizonAt(withFar, 90)} vs ${expected}`);
  assert.ok(horizonAt(withFar, 270) <= 0, 'west stays open');
});

test('the max-height early exit changes nothing', () => {
  const size = 300;
  const hf = grid(size, 12, 0, 0, (x, y) =>
    1500 + 900 * Math.sin(x / 23) * Math.cos(y / 31) + 600 * Math.sin((x + y) / 57) + 300 * Math.cos(x / 7 - y / 11));
  const highest = maxHeight(hf);
  for (const [px, py] of [[150, 150], [40, 260], [211, 77]]) {
    const exact = horizonProfile(hf, px, py, { azimuths: 72, highest: Infinity });
    const fast = horizonProfile(hf, px, py, { azimuths: 72, highest });
    for (let i = 0; i < exact.length; i++) assert.equal(fast[i], exact[i], `azimuth ${i * 5}`);
  }
});
