import { test } from 'node:test';
import assert from 'node:assert/strict';
import { slopeAspect, normalAt, sampleBilinear, elevationAt, contains } from '../src/terrain.js';
import { lonToTileX, latToTileY, tileXToLon, tileYToLat, metersPerPixel, decodeTerrarium, windowTiles, zoomForResolution } from '../src/tiles.js';

const synthetic = (f, size = 5, mpp = 100) => {
  const data = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) data[y * size + x] = f(x, y);
  return { data, width: size, height: size, metresPerPixel: mpp, z: 12, originX: 0, originY: 0 };
};

test('aspect follows compass bearing of the downhill direction', () => {
  const cases = [
    [180, (x, y) => 1000 - y * 100],
    [0, (x, y) => 1000 + y * 100],
    [90, (x, y) => 1000 - x * 100],
    [270, (x, y) => 1000 + x * 100],
    [135, (x, y) => 1000 - y * 100 - x * 100],
  ];
  for (const [expected, f] of cases) {
    const { aspect } = slopeAspect(synthetic(f), 2, 2);
    const diff = Math.abs(((aspect - expected + 540) % 360) - 180);
    assert.ok(diff < 0.01, `expected ${expected}, got ${aspect}`);
  }
});

test('slope angle matches the geometric gradient', () => {
  assert.ok(Math.abs(slopeAspect(synthetic((x, y) => 1000 - y * 100), 2, 2).slope - 45) < 0.01);
  assert.ok(Math.abs(slopeAspect(synthetic(() => 1000), 2, 2).slope) < 0.01);
  const gentle = slopeAspect(synthetic((x, y) => 1000 - y * 100, 5, 200), 2, 2).slope;
  assert.ok(Math.abs(gentle - 26.565) < 0.01, `got ${gentle}`);
});

test('flat terrain has an upward normal', () => {
  const n = normalAt(synthetic(() => 500), 2, 2);
  assert.ok(Math.abs(n.z - 1) < 1e-9 && Math.abs(n.x) < 1e-9 && Math.abs(n.y) < 1e-9);
});

test('bilinear sampling interpolates and clamps at edges', () => {
  const hf = synthetic((x) => x * 10);
  assert.ok(Math.abs(sampleBilinear(hf, 1.5, 2) - 15) < 1e-6);
  assert.equal(sampleBilinear(hf, -5, 2), 0);
  assert.equal(sampleBilinear(hf, 99, 2), 40);
});

test('elevationAt rejects positions outside the mosaic', () => {
  const hf = synthetic(() => 500);
  hf.z = 12; hf.originX = 2126; hf.originY = 1459;
  assert.ok(!contains(hf, 45.83, 0));
  assert.ok(Number.isNaN(elevationAt(hf, 45.83, 0)));
});

test('mercator tile math round-trips', () => {
  for (const [lat, lon] of [[45.83, 6.86], [-33.9, 18.4], [60, 10], [0, 0]]) {
    for (const z of [8, 12, 15]) {
      assert.ok(Math.abs(tileXToLon(lonToTileX(lon, z), z) - lon) < 1e-9);
      assert.ok(Math.abs(tileYToLat(latToTileY(lat, z), z) - lat) < 1e-9);
    }
  }
});

test('ground sample distance halves with each zoom level', () => {
  const a = metersPerPixel(45.83, 12);
  assert.ok(Math.abs(a / metersPerPixel(45.83, 13) - 2) < 1e-9);
  assert.ok(Math.abs(a - 26.6) < 0.2, `got ${a}`);
  assert.equal(zoomForResolution(45.83, 30), 12);
});

test('terrarium decoding covers the documented range', () => {
  assert.equal(decodeTerrarium(128, 0, 0), 0);
  assert.ok(Math.abs(decodeTerrarium(146, 197, 0) - 4805) < 1);
  assert.equal(decodeTerrarium(146, 213, 0), 4821);
  assert.equal(decodeTerrarium(0, 0, 0), -32768);
});

test('window tiling covers the requested span', () => {
  const w = windowTiles(45.83, 6.86, 12, 2048);
  assert.ok(w.width >= 2048 && w.height >= 2048);
  assert.equal(w.tiles.length, w.cols * w.rows);
  assert.ok(w.tiles.every((t) => t.col < w.cols && t.row < w.rows));
});
