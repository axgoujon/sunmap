/**
 * Browser PNG decode. The 2D canvas is the only decoder available, so the
 * context is pinned to sRGB with no smoothing: terrarium values are exact
 * bytes and any colour management would corrupt the elevations.
 */
export async function decodeImage(buffer) {
  const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }));
  const width = bitmap.width;
  const height = bitmap.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, width, height, { colorSpace: 'srgb' });
  bitmap.close();
  return { width, height, data, channels: 4 };
}
