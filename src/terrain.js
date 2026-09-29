import {
  TILE_SIZE, TERRAIN_SOURCE, tileUrl, windowTiles, mosaicPixel,
  metersPerPixel, decodeTerrarium, tileXToLon, tileYToLat,
} from './tiles.js';

const NO_DATA = -32768;

async function fetchTile(tile, source, decode, signal) {
  const res = await fetch(tileUrl(tile.z, tile.x, tile.y, source), { signal });
  if (!res.ok) throw new Error(`tile ${tile.z}/${tile.x}/${tile.y}: HTTP ${res.status}`);
  return decode(await res.arrayBuffer());
}

async function pooled(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await worker(items[i], i);
      }
    })
  );
  return results;
}

/**
 * Assemble a square heightfield mosaic centred on lat/lon.
 * `decode` turns a PNG ArrayBuffer into {width,height,data} with 8-bit RGB.
 */
export async function loadHeightfield({
  lat, lon, zoom, size = 2048, source = TERRAIN_SOURCE,
  decode, concurrency = 8, signal,
}) {
  const win = windowTiles(lat, lon, zoom, size);
  const data = new Float32Array(win.width * win.height);

  const images = await pooled(win.tiles, concurrency, (t) => fetchTile(t, source, decode, signal));

  win.tiles.forEach((tile, i) => {
    const img = images[i];
    const stride = img.channels || 3;
    const ox = tile.col * TILE_SIZE;
    const oy = tile.row * TILE_SIZE;
    for (let y = 0; y < img.height; y++) {
      const dst = (oy + y) * win.width + ox;
      const src = y * img.width * stride;
      for (let x = 0; x < img.width; x++) {
        const s = src + x * stride;
        const e = decodeTerrarium(img.data[s], img.data[s + 1], img.data[s + 2]);
        data[dst + x] = e <= NO_DATA ? 0 : e;
      }
    }
  });

  return {
    data, width: win.width, height: win.height, z: zoom,
    originX: win.originX, originY: win.originY,
    metresPerPixel: metersPerPixel(lat, zoom),
    centre: { lat, lon },
    bounds: {
      west: tileXToLon(win.originX, zoom),
      east: tileXToLon(win.originX + win.cols, zoom),
      north: tileYToLat(win.originY, zoom),
      south: tileYToLat(win.originY + win.rows, zoom),
    },
    attribution: source.attribution,
  };
}

export function sampleBilinear(hf, x, y) {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= hf.width || y0 + 1 >= hf.height) {
    const cx = Math.min(hf.width - 1, Math.max(0, Math.round(x)));
    const cy = Math.min(hf.height - 1, Math.max(0, Math.round(y)));
    return hf.data[cy * hf.width + cx];
  }
  const fx = x - x0, fy = y - y0;
  const i = y0 * hf.width + x0;
  const a = hf.data[i], b = hf.data[i + 1];
  const c = hf.data[i + hf.width], d = hf.data[i + hf.width + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// sampleBilinear indexes texel centres; the mosaic coordinate of texel i's
// centre is i + 0.5, so point queries shift by half a pixel.
export const pixelOf = (hf, lat, lon) => {
  const p = mosaicPixel(hf, lat, lon);
  return { x: p.x - 0.5, y: p.y - 0.5 };
};

export const contains = (hf, lat, lon) => {
  const p = mosaicPixel(hf, lat, lon);
  return p.x >= 0 && p.y >= 0 && p.x < hf.width && p.y < hf.height;
};

// Returns NaN outside the mosaic. Callers doing point queries must check;
// ray marching relies on sampleBilinear's edge clamp instead.
export const elevationAt = (hf, lat, lon) => {
  if (!contains(hf, lat, lon)) return NaN;
  const p = pixelOf(hf, lat, lon);
  return sampleBilinear(hf, p.x, p.y);
};

// Surface normal in local metric space. Aspect/slope drive the incidence angle,
// which is the dominant term for ski-touring exposure.
export function normalAt(hf, x, y) {
  const d = hf.metresPerPixel;
  const dzdx = (sampleBilinear(hf, x + 1, y) - sampleBilinear(hf, x - 1, y)) / (2 * d);
  const dzdy = (sampleBilinear(hf, x, y + 1) - sampleBilinear(hf, x, y - 1)) / (2 * d);
  const len = Math.hypot(dzdx, dzdy, 1);
  return { x: -dzdx / len, y: -dzdy / len, z: 1 / len };
}

export function slopeAspect(hf, x, y) {
  const n = normalAt(hf, x, y);
  const slope = (Math.acos(Math.min(1, n.z)) * 180) / Math.PI;
  // Image space is x=east, y=south. Compass bearing = atan2(east, north).
  const aspect = (Math.atan2(n.x, -n.y) * 180) / Math.PI;
  return { slope, aspect: ((aspect % 360) + 360) % 360 };
}
