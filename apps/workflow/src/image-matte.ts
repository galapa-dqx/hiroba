/**
 * gpt-image-2 can neither ingest nor emit transparency — hand it a PNG with an
 * alpha channel and the transparent regions come back filled with a solid
 * colour. Most DQX images are opaque (~95%), but some carry transparency (shop
 * banners, badges), so to preserve it we matte onto black before the edit and
 * key the black back out after:
 *
 *   transparent → black   (matteOnBlack,   pre-edit)
 *   black → transparent    (keyBlackToAlpha, post-edit)
 *
 * Black is the sentinel — not white — because the trim step already treats
 * near-white as model-added padding (see image-trim); keying on white would
 * conflate the two. The tradeoff is that genuinely near-black *content* keys
 * out too, so we only matte images with a meaningful amount of transparency,
 * and only key back the images we matted. Even then it's strictly better than
 * the solid fill we produce today for the handful of images that need it.
 *
 * Pure raster transforms plus thin PNG byte wrappers, mirroring image-trim so
 * they're easy to test in isolation.
 */

import { decode, encode } from 'fast-png';

import type { Raster } from './image-trim';

/** A pixel is effectively see-through below this alpha (0–255). */
const OPAQUE_ALPHA = 250;

/**
 * Only matte when at least this fraction of pixels are see-through. Guards
 * against a stray transparent pixel triggering a black key-out that could eat
 * near-black content from an otherwise-opaque image.
 */
const MIN_TRANSPARENT_FRACTION = 0.02;

/**
 * Black key-out ramp on per-pixel brightness = max(r,g,b). Brightness (value),
 * not luma, so saturated pure colours (e.g. pure red text) read as content, not
 * background. The high end sits comfortably below real content brightness while
 * absorbing the near-black the model may hand back instead of pure black.
 */
const KEY_LOW = 16; // ≤ ⇒ fully transparent
const KEY_HIGH = 64; // ≥ ⇒ fully opaque; between ⇒ feathered

/** Fraction of pixels that are see-through (0 for a raster with no alpha channel). */
export function transparentFraction(r: Raster): number {
  if (r.channels < 4) return 0;
  const { data, width, height, channels } = r;
  const total = width * height;
  let count = 0;
  for (let p = 3; p < total * channels; p += channels) {
    if (data[p] < OPAQUE_ALPHA) count++;
  }
  return count / total;
}

/** Composite an RGBA raster over black, dropping alpha → opaque 3-channel RGB. */
export function matteOnBlack(r: Raster): Raster {
  const { data, width, height, channels } = r;
  const out = new Uint8Array(width * height * 3);
  for (let i = 0, o = 0; o < out.length; i += channels, o += 3) {
    const a = channels >= 4 ? data[i + 3] : 255;
    out[o] = Math.round((data[i] * a) / 255);
    out[o + 1] = Math.round((data[i + 1] * a) / 255);
    out[o + 2] = Math.round((data[i + 2] * a) / 255);
  }
  return { data: out, width, height, channels: 3 };
}

/**
 * Re-introduce alpha by keying near-black back to transparent — the inverse of
 * matteOnBlack. Returns a 4-channel RGBA raster; antialiased edges feather
 * through the KEY_LOW…KEY_HIGH band instead of hard-cutting.
 */
export function keyBlackToAlpha(r: Raster): Raster {
  const { data, width, height, channels } = r;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; o < out.length; i += channels, o += 4) {
    const red = data[i];
    const green = data[i + 1];
    const blue = data[i + 2];
    const brightness = Math.max(red, green, blue);
    let alpha: number;
    if (brightness <= KEY_LOW) alpha = 0;
    else if (brightness >= KEY_HIGH) alpha = 255;
    else
      alpha = Math.round(((brightness - KEY_LOW) / (KEY_HIGH - KEY_LOW)) * 255);
    out[o] = red;
    out[o + 1] = green;
    out[o + 2] = blue;
    out[o + 3] = alpha;
  }
  return { data: out, width, height, channels: 4 };
}

/**
 * Decode a PNG and, if it carries meaningful transparency, matte it onto black
 * and return the opaque PNG plus `matted: true`. Otherwise (no alpha, too little
 * transparency, non-PNG, or a codec hiccup) return the bytes unchanged with
 * `matted: false`. Only PNG is inspected — jpeg has no alpha, and fast-png
 * can't decode webp (transparent webp slips through unmatted).
 */
export function matteTransparentPng(bytes: Uint8Array): {
  bytes: Uint8Array;
  matted: boolean;
} {
  let decoded;
  try {
    decoded = decode(bytes);
  } catch {
    return { bytes, matted: false };
  }
  if (decoded.depth !== 8 || decoded.channels < 4)
    return { bytes, matted: false };

  const raster: Raster = {
    data: decoded.data as Uint8Array,
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
  };
  if (transparentFraction(raster) < MIN_TRANSPARENT_FRACTION)
    return { bytes, matted: false };

  const matted = matteOnBlack(raster);
  try {
    return {
      bytes: encode({
        width: matted.width,
        height: matted.height,
        data: matted.data,
        channels: matted.channels,
        depth: 8,
      }),
      matted: true,
    };
  } catch {
    return { bytes, matted: false };
  }
}

/**
 * Key near-black back to transparent on a PNG — the inverse of the pre-edit
 * matte, applied to gpt-image-2's output. Falls back to the input on any
 * decode/encode trouble.
 */
export function restoreTransparency(bytes: Uint8Array): Uint8Array {
  let decoded;
  try {
    decoded = decode(bytes);
  } catch {
    return bytes;
  }
  if (decoded.depth !== 8) return bytes;

  const keyed = keyBlackToAlpha({
    data: decoded.data as Uint8Array,
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
  });
  try {
    return encode({
      width: keyed.width,
      height: keyed.height,
      data: keyed.data,
      channels: keyed.channels,
      depth: 8,
    });
  } catch {
    return bytes;
  }
}
