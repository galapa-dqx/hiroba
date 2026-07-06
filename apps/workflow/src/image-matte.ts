/**
 * gpt-image-2 can neither ingest nor emit transparency — hand it a PNG with an
 * alpha channel and the transparent regions come back filled with a solid
 * colour. Most DQX images are opaque (~95%), but some carry transparency (shop
 * banners, badges), so to preserve it we recover alpha by differential matting:
 *
 *   pre-edit   detect meaningful transparency (hasMeaningfulTransparency);
 *              the Images binding mattes onto white and pads (see image-edit's
 *              matteAndPadForTwoUp), and the edit prompt asks for the localized
 *              artwork rendered TWICE, stacked — over black on top, over white
 *              below (TWO_UP_PROMPT)
 *   post-edit  split the two-up, align the halves, and solve per pixel
 *              (recoverAlphaFromTwoUp):
 *
 *                C_black = α·F + (1−α)·b0        C_white = α·F + (1−α)·w0
 *                ⇒  α = 1 − (C_white − C_black)/(w0 − b0)
 *                   F = (C_black − (1−α)·b0)/α
 *
 * Because both copies come from a single generation the foreground F is
 * pixel-identical between them (validated on 5 live samples; two separate
 * generations drift by ~10% mean and are not even rigidly alignable). The
 * halves do land a rigid translation apart (observed ≤ ~26 px), so we align by
 * normalized cross-correlation of gradient magnitude — coarse-to-fine with a
 * parabolic subpixel refine — before solving. Unlike the earlier sentinel-key
 * approach (matte on black, key near-black back out) this reconstructs true
 * soft alpha and never eats near-black or near-white content.
 *
 * Pure raster transforms plus thin PNG byte wrappers, mirroring image-trim so
 * they're easy to test in isolation.
 */

import { decode, encode, type DecodedPng } from 'fast-png';

import type { Raster } from './image-trim';

/** A pixel is effectively see-through below this alpha (0–255). */
const OPAQUE_ALPHA = 250;

/**
 * Only matte when at least this fraction of pixels are see-through. Guards
 * against a stray transparent pixel sending an effectively-opaque image
 * through the two-up round trip for nothing.
 */
const MIN_TRANSPARENT_FRACTION = 0.02;

/** Row background classification (border-column median brightness, 0–255). */
const DARK_ROW = 90;
const LIGHT_ROW = 166;
/** How many columns on each side count as "border" for row classification. */
const BORDER_COLS = 30;
/** Each half of the two-up must be at least this tall to be plausible. */
const MIN_HALF = 32;

/** Alignment search: coarse pass on a /4 downsample, then a full-res refine. */
const COARSE_FACTOR = 4;
const COARSE_DY = 16; // ×COARSE_FACTOR = ±64 px vertically
const COARSE_DX = 4; // ×COARSE_FACTOR = ±16 px horizontally
const REFINE = 3;
/** Below this gradient correlation the halves don't contain the same artwork. */
const MIN_CORRELATION = 0.15;

/** Solved alpha this close to 0/1 snaps, killing matting noise in flat areas. */
const ALPHA_SNAP = 0.02;
/** b0/w0 must be at least this far apart per channel for the solve to be sane. */
const MIN_BG_SEPARATION = 64;

/** The prompt clause that requests the stacked black/white two-up. */
export const TWO_UP_PROMPT = [
  'Output a single image that contains the localized artwork TWICE, stacked',
  'vertically: the top copy sits on a solid pure black background, the bottom',
  'copy sits on a solid pure white background. The two copies must be perfectly',
  'identical to each other in every way except the background color behind them.',
  'Do not add any borders, captions, or other elements.',
].join('\n');

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

/**
 * Whether a decoded PNG carries transparency worth the two-up round trip.
 * Truecolor-with-alpha rasters get the pixel-fraction test; indexed rasters
 * keep alpha in the tRNS table, so count pixels whose palette entry is
 * see-through (or, when indices are bit-packed at depth < 8, settle for any
 * see-through entry existing — an indexed image that bothers to declare tRNS
 * uses it). Exported for tests; callers use {@link hasMeaningfulTransparency}.
 */
export function decodedHasMeaningfulTransparency(
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
): boolean {
  if (decoded.depth > 8) return false;
  if (decoded.palette) {
    const trns = decoded.transparency;
    if (!trns) return false;
    if (decoded.depth !== 8) {
      for (const a of trns) if (a < OPAQUE_ALPHA) return true;
      return false;
    }
    const data = decoded.data as Uint8Array;
    let count = 0;
    for (const index of data) if ((trns[index] ?? 255) < OPAQUE_ALPHA) count++;
    return count / (decoded.width * decoded.height) >= MIN_TRANSPARENT_FRACTION;
  }
  if (decoded.depth !== 8 || decoded.channels < 4) return false;
  const raster: Raster = {
    data: decoded.data as Uint8Array,
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
  };
  return transparentFraction(raster) >= MIN_TRANSPARENT_FRACTION;
}

/**
 * Whether these bytes are a PNG with meaningful transparency — the gate for the
 * two-up flow: matte+pad via the Images binding (image-edit), append
 * {@link TWO_UP_PROMPT} to the edit prompt, and recover alpha from the result
 * with {@link recoverAlphaFromTwoUp}. False for anything else (opaque, junk, or
 * a format fast-png can't decode — jpeg has no alpha; transparent webp still
 * slips through unmatted). Opaque images stay on the plain edit path untouched.
 */
export function hasMeaningfulTransparency(bytes: Uint8Array): boolean {
  let decoded;
  try {
    decoded = decode(bytes);
  } catch {
    return false;
  }
  return decodedHasMeaningfulTransparency(decoded);
}

/** Median of a small numeric array (mutates its argument). */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  return values[values.length >> 1];
}

/**
 * Classify each row by the brightness of its border columns: 1 = dark (black
 * background), −1 = light (white background), 0 = neither (artwork crosses the
 * border, or a mid-tone). Border columns, not the full row, so full-width
 * artwork doesn't hide the background.
 */
function classifyRows(r: Raster): Int8Array {
  const { data, width, height, channels } = r;
  const cols = Math.min(BORDER_COLS, Math.max(1, width >> 3));
  const out = new Int8Array(height);
  const samples: number[] = [];
  for (let y = 0; y < height; y++) {
    samples.length = 0;
    for (let x = 0; x < cols; x++) {
      for (const xx of [x, width - 1 - x]) {
        const p = (y * width + xx) * channels;
        samples.push((data[p] + data[p + 1] + data[p + 2]) / 3);
      }
    }
    const level = median(samples);
    out[y] = level < DARK_ROW ? 1 : level > LIGHT_ROW ? -1 : 0;
  }
  return out;
}

/**
 * The row where the black half ends and the white half begins — the split that
 * maximizes dark-rows-above + light-rows-below. Null when no split leaves a
 * plausibly two-up image (both halves tall enough and mostly background-true).
 */
export function findSplitRow(r: Raster): number | null {
  const rows = classifyRows(r);
  const h = rows.length;
  let totalLight = 0;
  for (let y = 0; y < h; y++) totalLight += rows[y] === -1 ? 1 : 0;

  let best = -1;
  let bestScore = -1;
  let dark = 0;
  let light = totalLight;
  for (let y = 1; y < h; y++) {
    dark += rows[y - 1] === 1 ? 1 : 0;
    light -= rows[y - 1] === -1 ? 1 : 0;
    if (y < MIN_HALF || h - y < MIN_HALF) continue;
    const score = dark + light;
    if (score > bestScore) {
      bestScore = score;
      best = y;
    }
  }
  if (best < 0) return null;
  // both halves must actually look like their background
  let darkTop = 0;
  for (let y = 0; y < best; y++) darkTop += rows[y] === 1 ? 1 : 0;
  let lightBot = 0;
  for (let y = best; y < h; y++) lightBot += rows[y] === -1 ? 1 : 0;
  if (darkTop < best * 0.5 || lightBot < (h - best) * 0.5) return null;
  return best;
}

/** Copy `count` rows starting at `y0` into a new raster. */
function cropRows(r: Raster, y0: number, count: number): Raster {
  const rowBytes = r.width * r.channels;
  return {
    data: r.data.slice(y0 * rowBytes, (y0 + count) * rowBytes),
    width: r.width,
    height: count,
    channels: r.channels,
  };
}

/** Luma as float, (r + 2g + b) / 4. */
function lumaOf(r: Raster): Float32Array {
  const { data, width, height, channels } = r;
  const out = new Float32Array(width * height);
  for (let i = 0, p = 0; i < out.length; i++, p += channels) {
    out[i] = (data[p] + 2 * data[p + 1] + data[p + 2]) / 4;
  }
  return out;
}

/** L1 gradient magnitude of a luma field (zero on the border ring). */
function gradientMagnitude(
  lum: Float32Array,
  width: number,
  height: number,
): Float32Array {
  const out = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      out[i] =
        Math.abs(lum[i + 1] - lum[i - 1]) / 2 +
        Math.abs(lum[i + width] - lum[i - width]) / 2;
    }
  }
  return out;
}

/** Box-average downsample by `factor` (truncating remainder rows/columns). */
function downsample(
  field: Float32Array,
  width: number,
  height: number,
  factor: number,
): { field: Float32Array; width: number; height: number } {
  const w = Math.floor(width / factor);
  const h = Math.floor(height / factor);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let yy = 0; yy < factor; yy++) {
        for (let xx = 0; xx < factor; xx++) {
          sum += field[(y * factor + yy) * width + (x * factor + xx)];
        }
      }
      out[y * w + x] = sum / (factor * factor);
    }
  }
  return { field: out, width: w, height: h };
}

/**
 * Normalized cross-correlation between `a[y][x]` and `b[y − dy][x − dx]` over
 * their overlap. Zero when the overlap is degenerate or textureless.
 */
function ncc(
  a: Float32Array,
  b: Float32Array,
  width: number,
  height: number,
  dy: number,
  dx: number,
): number {
  const y0 = Math.max(0, dy);
  const y1 = height + Math.min(0, dy);
  const x0 = Math.max(0, dx);
  const x1 = width + Math.min(0, dx);
  const n = (y1 - y0) * (x1 - x0);
  if (n < 256) return 0;
  let sa = 0;
  let sb = 0;
  let sab = 0;
  let sa2 = 0;
  let sb2 = 0;
  for (let y = y0; y < y1; y++) {
    let ia = y * width + x0;
    let ib = (y - dy) * width + (x0 - dx);
    for (let x = x0; x < x1; x++, ia++, ib++) {
      const va = a[ia];
      const vb = b[ib];
      sa += va;
      sb += vb;
      sab += va * vb;
      sa2 += va * va;
      sb2 += vb * vb;
    }
  }
  const cov = sab - (sa * sb) / n;
  const varA = sa2 - (sa * sa) / n;
  const varB = sb2 - (sb * sb) / n;
  if (varA <= 0 || varB <= 0) return 0;
  return cov / Math.sqrt(varA * varB);
}

/** Parabolic peak refinement from three samples; 0 when degenerate. */
function subpixelOffset(cm1: number, c0: number, cp1: number): number {
  const denom = cm1 - 2 * c0 + cp1;
  if (Math.abs(denom) < 1e-9) return 0;
  const off = (0.5 * (cm1 - cp1)) / denom;
  return Math.abs(off) <= 1 ? off : 0;
}

/**
 * The rigid shift (dy, dx) of `bot` relative to `top` — i.e. top[y][x] matches
 * bot[y − dy][x − dx] — found by gradient-magnitude NCC: a coarse pass on a /4
 * downsample, a ±{@link REFINE} full-res pass, then parabolic subpixel. Null
 * when even the best correlation is too weak for the halves to share artwork.
 */
export function estimateShift(
  top: Raster,
  bot: Raster,
): { dy: number; dx: number; corr: number } | null {
  const { width, height } = top;
  const gradTop = gradientMagnitude(lumaOf(top), width, height);
  const gradBot = gradientMagnitude(lumaOf(bot), width, height);

  const dsT = downsample(gradTop, width, height, COARSE_FACTOR);
  const dsB = downsample(gradBot, width, height, COARSE_FACTOR);
  let bestDy = 0;
  let bestDx = 0;
  let bestCorr = -Infinity;
  for (let dy = -COARSE_DY; dy <= COARSE_DY; dy++) {
    for (let dx = -COARSE_DX; dx <= COARSE_DX; dx++) {
      const c = ncc(dsT.field, dsB.field, dsT.width, dsT.height, dy, dx);
      if (c > bestCorr) {
        bestCorr = c;
        bestDy = dy;
        bestDx = dx;
      }
    }
  }

  const cy = bestDy * COARSE_FACTOR;
  const cx = bestDx * COARSE_FACTOR;
  const grid = new Map<string, number>();
  bestCorr = -Infinity;
  let fineDy = cy;
  let fineDx = cx;
  for (let dy = cy - REFINE; dy <= cy + REFINE; dy++) {
    for (let dx = cx - REFINE; dx <= cx + REFINE; dx++) {
      const c = ncc(gradTop, gradBot, width, height, dy, dx);
      grid.set(`${dy},${dx}`, c);
      if (c > bestCorr) {
        bestCorr = c;
        fineDy = dy;
        fineDx = dx;
      }
    }
  }
  if (bestCorr < MIN_CORRELATION) return null;

  const at = (dy: number, dx: number): number =>
    grid.get(`${dy},${dx}`) ?? ncc(gradTop, gradBot, width, height, dy, dx);
  const dy =
    fineDy +
    subpixelOffset(at(fineDy - 1, fineDx), bestCorr, at(fineDy + 1, fineDx));
  const dx =
    fineDx +
    subpixelOffset(at(fineDy, fineDx - 1), bestCorr, at(fineDy, fineDx + 1));
  return { dy, dx, corr: bestCorr };
}

/**
 * Per-channel background level of a half: the median of its border-column
 * pixels on rows whose border matches `rowClass` (1 dark / −1 light). Falls
 * back to `fallback` when too few rows qualify.
 */
function backgroundLevel(
  r: Raster,
  rowClass: 1 | -1,
  fallback: number,
): [number, number, number] {
  const { data, width, height, channels } = r;
  const rows = classifyRows(r);
  const cols = Math.min(BORDER_COLS, Math.max(1, width >> 3));
  const red: number[] = [];
  const green: number[] = [];
  const blue: number[] = [];
  for (let y = 0; y < height; y++) {
    if (rows[y] !== rowClass) continue;
    for (let x = 0; x < cols; x++) {
      for (const xx of [x, width - 1 - x]) {
        const p = (y * width + xx) * channels;
        red.push(data[p]);
        green.push(data[p + 1]);
        blue.push(data[p + 2]);
      }
    }
    if (red.length > 6000) break;
  }
  if (red.length < 64) return [fallback, fallback, fallback];
  return [median(red), median(green), median(blue)];
}

/**
 * Recover an RGBA image from a stacked two-up render (localized artwork over
 * black on top, over white below): split, align, and solve the two-background
 * matting equations per pixel. Returns null when the output doesn't look like
 * a usable two-up (no split, halves don't correlate, backgrounds too close) so
 * the caller can fail the image rather than ship a broken matte.
 */
export function recoverAlphaFromTwoUp(bytes: Uint8Array): Uint8Array | null {
  let decoded;
  try {
    decoded = decode(bytes);
  } catch {
    return null;
  }
  if (decoded.depth !== 8 || decoded.channels < 3) return null;

  const full: Raster = {
    data: decoded.data as Uint8Array,
    width: decoded.width,
    height: decoded.height,
    channels: decoded.channels,
  };
  const split = findSplitRow(full);
  if (split === null) return null;

  const h = Math.min(split, full.height - split);
  const top = cropRows(full, split - h, h);
  const bot = cropRows(full, split, h);

  const shift = estimateShift(top, bot);
  if (!shift) return null;
  const { dy, dx } = shift;

  const b0 = backgroundLevel(top, 1, 0);
  const w0 = backgroundLevel(bot, -1, 255);
  const sep = [w0[0] - b0[0], w0[1] - b0[1], w0[2] - b0[2]];
  if (Math.min(...sep) < MIN_BG_SEPARATION) return null;

  // rows/columns whose bilinear source falls outside the white half are invalid
  const my0 = Math.ceil(Math.max(dy, 0)) + 2;
  const my1 = Math.ceil(Math.max(-dy, 0)) + 2;
  const mx0 = Math.ceil(Math.max(dx, 0)) + 2;
  const mx1 = Math.ceil(Math.max(-dx, 0)) + 2;
  const outW = top.width - mx0 - mx1;
  const outH = h - my0 - my1;
  if (outW < 8 || outH < 8) return null;

  const { data: tData, width, channels: tCh } = top;
  const { data: bData, channels: bCh } = bot;
  const out = new Uint8Array(outW * outH * 4);
  for (let y = my0; y < h - my1; y++) {
    const sy = y - dy;
    const y0 = Math.floor(sy);
    const fy = sy - y0;
    for (let x = mx0; x < width - mx1; x++) {
      const sx = x - dx;
      const x0 = Math.floor(sx);
      const fx = sx - x0;
      const p00 = (y0 * width + x0) * bCh;
      const p01 = p00 + bCh;
      const p10 = p00 + width * bCh;
      const p11 = p10 + bCh;
      const tp = (y * width + x) * tCh;

      let alphaSum = 0;
      const black = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const white =
          bData[p00 + c] * (1 - fy) * (1 - fx) +
          bData[p01 + c] * (1 - fy) * fx +
          bData[p10 + c] * fy * (1 - fx) +
          bData[p11 + c] * fy * fx;
        black[c] = tData[tp + c];
        alphaSum += 1 - (white - black[c]) / sep[c];
      }
      let alpha = Math.min(1, Math.max(0, alphaSum / 3));
      if (alpha < ALPHA_SNAP) alpha = 0;
      else if (alpha > 1 - ALPHA_SNAP) alpha = 1;

      const o = ((y - my0) * outW + (x - mx0)) * 4;
      if (alpha === 0) {
        out[o + 3] = 0;
      } else {
        for (let c = 0; c < 3; c++) {
          const f = (black[c] - (1 - alpha) * b0[c]) / alpha;
          out[o + c] = Math.min(255, Math.max(0, Math.round(f)));
        }
        out[o + 3] = Math.round(alpha * 255);
      }
    }
  }

  try {
    return encode({
      width: outW,
      height: outH,
      data: out,
      channels: 4,
      depth: 8,
    });
  } catch {
    return null;
  }
}
