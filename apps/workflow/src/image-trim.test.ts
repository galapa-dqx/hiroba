import { encode } from 'fast-png';
import { describe, expect, it } from 'vitest';

import {
  contentBox,
  crop,
  fitAspect,
  imageDimensions,
  trimToAspect,
  type Raster,
} from './image-trim';

/** Solid-white RGBA raster. */
function whiteRaster(width: number, height: number): Raster {
  const data = new Uint8Array(width * height * 4).fill(255);
  return { data, width, height, channels: 4 };
}

function fillRect(
  r: Raster,
  x0: number,
  y0: number,
  w: number,
  h: number,
  rgb: [number, number, number],
) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const p = (y * r.width + x) * r.channels;
      r.data[p] = rgb[0];
      r.data[p + 1] = rgb[1];
      r.data[p + 2] = rgb[2];
      r.data[p + 3] = 255;
    }
  }
}

const pngOf = (r: Raster): Uint8Array =>
  encode({
    width: r.width,
    height: r.height,
    data: r.data,
    channels: r.channels,
    depth: 8,
  });

describe('contentBox', () => {
  it('finds the non-white bounding box', () => {
    const r = whiteRaster(10, 10);
    fillRect(r, 3, 4, 4, 2, [0, 0, 0]); // 4×2 black block
    expect(contentBox(r)).toEqual({ x: 3, y: 4, width: 4, height: 2 });
  });

  it('treats off-white as background but keeps darker content', () => {
    const r = whiteRaster(8, 8);
    fillRect(r, 0, 0, 8, 8, [248, 246, 244]); // off-white wash → background
    fillRect(r, 2, 2, 3, 3, [200, 10, 10]); // red content
    expect(contentBox(r)).toEqual({ x: 2, y: 2, width: 3, height: 3 });
  });

  it('returns the full frame when everything is background', () => {
    expect(contentBox(whiteRaster(5, 6))).toEqual({
      x: 0,
      y: 0,
      width: 5,
      height: 6,
    });
  });
});

describe('fitAspect', () => {
  it('narrows a too-wide box (center-crop width)', () => {
    expect(fitAspect({ x: 0, y: 0, width: 10, height: 4 }, 1)).toEqual({
      x: 3,
      y: 0,
      width: 4,
      height: 4,
    });
  });
  it('shortens a too-tall box (center-crop height)', () => {
    expect(fitAspect({ x: 0, y: 0, width: 4, height: 10 }, 1)).toEqual({
      x: 0,
      y: 3,
      width: 4,
      height: 4,
    });
  });
  it('leaves a matching box unchanged', () => {
    expect(fitAspect({ x: 1, y: 1, width: 6, height: 3 }, 2)).toEqual({
      x: 1,
      y: 1,
      width: 6,
      height: 3,
    });
  });
});

describe('crop', () => {
  it('extracts the sub-raster', () => {
    const r = whiteRaster(4, 4);
    fillRect(r, 1, 1, 2, 2, [10, 20, 30]);
    const c = crop(r, { x: 1, y: 1, width: 2, height: 2 });
    expect([c.width, c.height]).toEqual([2, 2]);
    expect([c.data[0], c.data[1], c.data[2]]).toEqual([10, 20, 30]);
  });
});

describe('imageDimensions', () => {
  it('reads PNG dimensions from the header', () => {
    const png = pngOf(whiteRaster(12, 7));
    expect(imageDimensions(png)).toEqual({ width: 12, height: 7 });
  });
});

describe('trimToAspect', () => {
  it('trims the padding and crops to the original aspect (codec round-trip)', () => {
    // 12×12 output: a 6×3 content block padded with white.
    const out = whiteRaster(12, 12);
    fillRect(out, 3, 4, 6, 3, [20, 120, 200]);
    const original = pngOf(whiteRaster(8, 4)); // aspect 2:1

    const trimmed = trimToAspect(pngOf(out), original);
    const dims = imageDimensions(trimmed);
    expect(dims).toEqual({ width: 6, height: 3 }); // content box already 2:1
  });

  it('returns the input unchanged when there is no padding', () => {
    const full = whiteRaster(6, 6);
    fillRect(full, 0, 0, 6, 6, [10, 10, 10]); // content fills the frame
    const png = pngOf(full);
    expect(trimToAspect(png, pngOf(whiteRaster(6, 6)))).toBe(png);
  });
});
