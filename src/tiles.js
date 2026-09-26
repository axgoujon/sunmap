export const TILE_SIZE = 256;
export const EARTH_CIRCUMFERENCE = 40075016.686;

// Terrain source: AWS Open Data "Terrain Tiles", terrarium encoding.
// Global, CORS-open, no API key. Single point of change if the provider moves.
export const TERRAIN_SOURCE = {
  url: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
  maxZoom: 15,
  attribution:
    'Elevation: AWS Terrain Tiles (SRTM, NED, and other public sources)',
};

export const tileUrl = (z, x, y, source = TERRAIN_SOURCE) =>
  source.url.replace('{z}', z).replace('{x}', x).replace('{y}', y);

export const lonToTileX = (lon, z) => ((lon + 180) / 360) * 2 ** z;

export const latToTileY = (lat, z) =>
  ((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * 2 ** z;

export const tileXToLon = (x, z) => (x / 2 ** z) * 360 - 180;

export const tileYToLat = (y, z) =>
  (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

// Ground sample distance. Mercator scale varies with latitude, so this is only
// constant across a window narrow enough that cos(lat) barely moves.
export const metersPerPixel = (lat, z) =>
  (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * 2 ** z);

export const decodeTerrarium = (r, g, b) => r * 256 + g + b / 256 - 32768;

// Zoom whose ground sample distance is closest to a target, clamped to source.
export function zoomForResolution(lat, targetMetres, source = TERRAIN_SOURCE) {
  const z = Math.log2((EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / (TILE_SIZE * targetMetres));
  return Math.max(0, Math.min(source.maxZoom, Math.round(z)));
}

// Tile range covering a pixel window of `size` centred on lat/lon at zoom z.
export function windowTiles(lat, lon, z, size) {
  const cx = lonToTileX(lon, z) * TILE_SIZE;
  const cy = latToTileY(lat, z) * TILE_SIZE;
  const originX = Math.floor((cx - size / 2) / TILE_SIZE);
  const originY = Math.floor((cy - size / 2) / TILE_SIZE);
  const endX = Math.ceil((cx + size / 2) / TILE_SIZE);
  const endY = Math.ceil((cy + size / 2) / TILE_SIZE);
  const n = 2 ** z;
  const tiles = [];
  for (let ty = originY; ty < endY; ty++) {
    for (let tx = originX; tx < endX; tx++) {
      if (ty < 0 || ty >= n) continue;
      tiles.push({ z, x: ((tx % n) + n) % n, y: ty, col: tx - originX, row: ty - originY });
    }
  }
  return {
    tiles,
    originX,
    originY,
    cols: endX - originX,
    rows: endY - originY,
    width: (endX - originX) * TILE_SIZE,
    height: (endY - originY) * TILE_SIZE,
    // Offset of the requested window inside the assembled mosaic.
    offsetX: cx - size / 2 - originX * TILE_SIZE,
    offsetY: cy - size / 2 - originY * TILE_SIZE,
  };
}

// Pixel coordinate within an assembled mosaic, for a geographic position.
export function mosaicPixel(mosaic, lat, lon) {
  return {
    x: lonToTileX(lon, mosaic.z) * TILE_SIZE - mosaic.originX * TILE_SIZE,
    y: latToTileY(lat, mosaic.z) * TILE_SIZE - mosaic.originY * TILE_SIZE,
  };
}
