/**
 * Trim the padding gpt-image-2 adds around its edit, then crop to the original
 * image's aspect ratio — but only when the trimmed content has drifted more
 * than ASPECT_TOLERANCE from that ratio, so we don't shave slivers off images
 * the model got near-enough right. Pure-JS PNG codec (fast-png) so it runs in
 * the Worker; the geometry (contentBox / fitAspect / crop) is exported for
 * testing.
 *
 * Note: this trims *edge* padding — solid background rows/columns from each side
 * — so it removes an added border without touching the interior. Background is
 * near-white *or* near-transparent, so it handles both the opaque white the
 * model pads with and the transparency restored by image-matte.
 *
 * Originals with transparent edge margins (e.g. a title strip on a mostly
 * empty canvas) get special treatment: their canvas aspect says nothing about
 * the artwork, and the matte round trip hands back only the artwork. Fitting
 * that against the canvas aspect would carve the artwork up, so the fit runs
 * against the original's *visible content* aspect instead, and the transparent
 * margins are re-inserted afterwards (scaled) so the localized image keeps the
 * original's canvas geometry.
 */

import { decode, encode, type DecodedPng } from 'fast-png';

/** R,G,B all ≥ this ⇒ background (white / off-white). */
const BG_THRESHOLD = 240;

/** alpha ≤ this ⇒ background (see-through padding, e.g. from image-matte). */
const BG_ALPHA = 8;

/**
 * How far the trimmed content box's aspect may drift from the original before
 * we center-crop to correct it (relative to the target, so 0.05 = 5%).
 * gpt-image-2 rarely returns the exact requested ratio; within this band we
 * keep its slightly-off dimensions rather than shaving a sliver off every
 * image for no real gain.
 */
const ASPECT_TOLERANCE = 0.05;

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

/**
 * Bounding box of the pixels that are actually visible (alpha above BG_ALPHA).
 * Handles the alpha shapes fast-png decodes: truecolor / gray with an alpha
 * channel, and 8-bit indexed with a tRNS table. Null when the image carries no
 * alpha information (nothing to measure) or is entirely transparent.
 */
export function alphaContentBox(
  decoded: Pick<
    DecodedPng,
    | 'data'
    | 'width'
    | 'height'
    | 'channels'
    | 'depth'
    | 'palette'
    | 'transparency'
  >,
): Box | null {
  if (decoded.depth !== 8) return null;
  const { width, height, channels } = decoded;
  const data = decoded.data as Uint8Array;
  let alphaOf: (px: number) => number;
  if (decoded.palette) {
    const trns = decoded.transparency;
    if (!trns) return null;
    alphaOf = (px) => trns[data[px]] ?? 255;
  } else if (channels === 2 || channels === 4) {
    alphaOf = (px) => data[px * channels + channels - 1];
  } else {
    return null;
  }

  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (alphaOf(y * width + x) > BG_ALPHA) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Canvas dimensions of the original plus, when it has transparent edge margins, the tight box of its visible pixels. */
export type OriginalGeometry = {
  width: number;
  height: number;
  /** Visible-content box; null when the content fills the canvas (opaque images, undecodable formats). */
  content: Box | null;
};

/**
 * Measure the original image: canvas dimensions always (PNG/GIF/JPEG header),
 * and for PNGs whose alpha leaves transparent edge margins, the box the
 * visible artwork occupies. Null when the bytes aren't a readable image.
 */
export function originalGeometry(bytes: Uint8Array): OriginalGeometry | null {
  let decoded: DecodedPng | null = null;
  try {
    decoded = decode(bytes);
  } catch {
    // not a PNG fast-png can read — header dimensions only
  }
  const dims = decoded
    ? { width: decoded.width, height: decoded.height }
    : imageDimensions(bytes);
  if (!dims || !dims.width || !dims.height) return null;

  let content: Box | null = null;
  if (decoded) {
    const box = alphaContentBox(decoded);
    if (box && (box.width < dims.width || box.height < dims.height))
      content = box;
  }
  return { width: dims.width, height: dims.height, content };
}

/**
 * Re-insert the original's transparent edge margins around a localized raster:
 * the raster is the visible content, so scale each original margin by that
 * axis's content growth factor and pad with fully transparent pixels. Per-axis
 * scales (not one average) so margins stay proportional even when the model's
 * output drifted within ASPECT_TOLERANCE and the axes grew unevenly. The
 * result's canvas geometry matches the original's, with the artwork in the
 * same relative position. Accepts any raster shape (gray / gray+alpha / RGB /
 * RGBA); always returns RGBA.
 */
export function restoreMargins(
  r: Raster,
  canvas: { width: number; height: number },
  content: Box,
): Raster {
  const sx = r.width / content.width;
  const sy = r.height / content.height;
  const left = Math.round(content.x * sx);
  const top = Math.round(content.y * sy);
  const right = Math.round((canvas.width - content.x - content.width) * sx);
  const bottom = Math.round((canvas.height - content.y - content.height) * sy);
  const width = r.width + left + right;
  const height = r.height + top + bottom;
  const gray = r.channels <= 2; // single color channel, replicated into RGB
  const hasAlpha = r.channels === 2 || r.channels === 4;
  const out = new Uint8Array(width * height * 4); // zeroed → fully transparent
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const src = (y * r.width + x) * r.channels;
      const dst = ((top + y) * width + (left + x)) * 4;
      out[dst] = r.data[src];
      out[dst + 1] = gray ? r.data[src] : r.data[src + 1];
      out[dst + 2] = gray ? r.data[src] : r.data[src + 2];
      out[dst + 3] = hasAlpha ? r.data[src + r.channels - 1] : 255;
    }
  }
  return { data: out, width, height, channels: 4 };
}

/**
 * Center-crop a box to `aspect` (w/h) — only ever removes, never adds. When the
 * box is already within `tolerance` (relative) of the target aspect, it's left
 * unchanged: the model's output is close enough that correcting it would only
 * remove a sliver.
 */
export function fitAspect(
  box: Box,
  aspect: number,
  tolerance = ASPECT_TOLERANCE,
): Box {
  let { x, y, width: w, height: h } = box;
  const cur = w / h;
  if (Math.abs(cur - aspect) <= aspect * tolerance) return box;
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
 * `originalBytes` — the visible content's aspect when the original carries
 * transparent edge margins (which are then re-inserted, scaled, so the result
 * keeps the original's canvas geometry), the full canvas aspect otherwise.
 * Falls back to the input on any decode/encode issue.
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
  const original = originalGeometry(originalBytes);
  const target = original?.content ?? original;
  if (target) box = fitAspect(box, target.width / target.height);

  const content = original?.content ?? null;

  if (
    !content &&
    box.x === 0 &&
    box.y === 0 &&
    box.width === raster.width &&
    box.height === raster.height
  ) {
    return outputPng; // nothing to trim
  }

  let result = crop(raster, box);
  if (original && content) result = restoreMargins(result, original, content);
  try {
    return encode({
      width: result.width,
      height: result.height,
      data: result.data,
      channels: result.channels,
      depth: 8,
    });
  } catch {
    return outputPng;
  }
}
