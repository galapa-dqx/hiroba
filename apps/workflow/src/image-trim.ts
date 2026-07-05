/**
 * Trim the padding gpt-image-2 adds around its edit, then crop to the original
 * image's aspect ratio. Pure-JS PNG codec (fast-png) so it runs in the Worker;
 * the geometry (contentBox / fitAspect / crop) is exported for testing.
 *
 * Note: this trims *edge* padding — solid background rows/columns from each side
 * — so it removes an added border without touching the interior. Background is
 * near-white *or* near-transparent, so it handles both the opaque white the
 * model pads with and the transparency restored by image-matte.
 */

import { decode, encode } from 'fast-png';

/** R,G,B all ≥ this ⇒ background (white / off-white). */
const BG_THRESHOLD = 240;

/** alpha ≤ this ⇒ background (see-through padding, e.g. from image-matte). */
const BG_ALPHA = 8;

export type Raster = {
  data: Uint8Array;
  width: number;
  height: number;
  channels: number;
};
export type Box = { x: number; y: number; width: number; height: number };

/** Read pixel dimensions straight from a file header (PNG / GIF / JPEG). */
export function imageDimensions(
  bytes: Uint8Array,
): { width: number; height: number } | null {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (
    bytes.length >= 24 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return { width: dv.getUint32(16), height: dv.getUint32(20) };
  }
  if (
    bytes.length >= 10 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46
  ) {
    return { width: dv.getUint16(6, true), height: dv.getUint16(8, true) };
  }
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let o = 2;
    while (o + 9 < bytes.length) {
      if (bytes[o] !== 0xff) {
        o++;
        continue;
      }
      const marker = bytes[o + 1];
      const isSof =
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc;
      if (isSof)
        return { height: dv.getUint16(o + 5), width: dv.getUint16(o + 7) };
      o += 2 + dv.getUint16(o + 2);
    }
  }
  return null;
}

/** Bounding box of the non-background pixels (the full image if it's all background). */
export function contentBox(r: Raster, threshold = BG_THRESHOLD): Box {
  const { data, width, height, channels } = r;
  const isBg = (px: number): boolean =>
    (channels >= 4 && data[px + 3] <= BG_ALPHA) ||
    (data[px] >= threshold &&
      data[px + 1] >= threshold &&
      data[px + 2] >= threshold);

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!isBg((y * width + x) * channels)) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return { x: 0, y: 0, width, height };
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Center-crop a box to `aspect` (w/h) — only ever removes, never adds. */
export function fitAspect(box: Box, aspect: number): Box {
  let { x, y, width: w, height: h } = box;
  const cur = w / h;
  if (cur > aspect) {
    const nw = Math.max(1, Math.round(h * aspect));
    x += Math.floor((w - nw) / 2);
    w = nw;
  } else if (cur < aspect) {
    const nh = Math.max(1, Math.round(w / aspect));
    y += Math.floor((h - nh) / 2);
    h = nh;
  }
  return { x, y, width: w, height: h };
}

/** Copy the pixels inside `box` into a new raster. */
export function crop(r: Raster, box: Box): Raster {
  const { data, width, channels } = r;
  const out = new Uint8Array(box.width * box.height * channels);
  const rowBytes = box.width * channels;
  for (let y = 0; y < box.height; y++) {
    const src = ((box.y + y) * width + box.x) * channels;
    out.set(data.subarray(src, src + rowBytes), y * rowBytes);
  }
  return { data: out, width: box.width, height: box.height, channels };
}

/**
 * Trim the added border off `outputPng` and crop it to the aspect ratio of
 * `originalBytes`. Falls back to the input on any decode/encode issue.
 */
export function trimToAspect(
  outputPng: Uint8Array,
  originalBytes: Uint8Array,
): Uint8Array {
  let decoded;
  try {
    decoded = decode(outputPng);
  } catch {
    return outputPng;
  }
  if (decoded.depth !== 8) return outputPng; // only 8-bit rasters

  const raster: Raster = {
    data: decoded.data as Uint8Array,
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
  };

  let box = contentBox(raster);
  const dims = imageDimensions(originalBytes);
  if (dims && dims.width && dims.height)
    box = fitAspect(box, dims.width / dims.height);

  if (
    box.x === 0 &&
    box.y === 0 &&
    box.width === raster.width &&
    box.height === raster.height
  ) {
    return outputPng; // nothing to trim
  }

  const cropped = crop(raster, box);
  try {
    return encode({
      width: cropped.width,
      height: cropped.height,
      data: cropped.data,
      channels: cropped.channels,
      depth: 8,
    });
  } catch {
    return outputPng;
  }
}
