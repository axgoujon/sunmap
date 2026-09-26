/**
 * Browser PNG decode. The 2D canvas is the only decoder available, so the
 * context is pinned to sRGB with no smoothing: terrarium values are exact
 * bytes and any colour management would corrupt the elevations.
 */
export async function decodeImage(buffer) {
  const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/png' }));
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { colorSpace: 'srgb', willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height, { colorSpace: 'srgb' });
  bitmap.close();
  return { width: bitmap.width, height: bitmap.height, data, channels: 4 };
}
