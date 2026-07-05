import { decode, encode } from 'fast-png';
import { describe, expect, it } from 'vitest';

import {
  keyBlackToAlpha,
  matteOnBlack,
  matteTransparentPng,
  restoreTransparency,
  transparentFraction,
} from './image-matte';
import type { Raster } from './image-trim';

/** RGBA raster from a flat [r,g,b,a] pixel list. */
function rgba(width: number, height: number, pixels: number[][]): Raster {
  const data = new Uint8Array(width * height * 4);
  pixels.forEach((p, i) => data.set(p, i * 4));
  return { data, width, height, channels: 4 };
}

const pngOf = (r: Raster): Uint8Array =>
  encode({
    width: r.width,
    height: r.height,
    data: r.data,
    channels: r.channels,
    depth: 8,
  });

describe('transparentFraction', () => {
  it('is 0 for a raster with no alpha channel', () => {
    const rgb: Raster = {
      data: new Uint8Array([1, 2, 3, 4, 5, 6]),
      width: 2,
      height: 1,
      channels: 3,
    };
    expect(transparentFraction(rgb)).toBe(0);
  });

  it('counts see-through pixels (alpha below the opaque cutoff)', () => {
    const r = rgba(2, 2, [
      [0, 0, 0, 0], // transparent
      [9, 9, 9, 128], // semi
      [9, 9, 9, 255], // opaque
      [9, 9, 9, 251], // opaque enough
    ]);
    expect(transparentFraction(r)).toBe(0.5);
  });
});

describe('matteOnBlack', () => {
  it('composites over black and drops alpha to 3 channels', () => {
    const r = rgba(1, 3, [
      [200, 100, 50, 0], // fully transparent → black
      [200, 100, 50, 255], // opaque → unchanged
      [200, 100, 40, 128], // half → ~half toward black
    ]);
    const out = matteOnBlack(r);
    expect(out.channels).toBe(3);
    expect(Array.from(out.data.slice(0, 3))).toEqual([0, 0, 0]);
    expect(Array.from(out.data.slice(3, 6))).toEqual([200, 100, 50]);
    expect(Array.from(out.data.slice(6, 9))).toEqual([100, 50, 20]);
  });
});

describe('keyBlackToAlpha', () => {
  it('keys near-black transparent and keeps bright pixels opaque', () => {
    const r = rgba(1, 3, [
      [0, 0, 0, 255], // black → transparent
      [255, 255, 255, 255], // white → opaque
      [0, 0, 255, 255], // saturated pure blue → opaque (brightness = 255)
    ]);
    const out = keyBlackToAlpha(r);
    expect(out.channels).toBe(4);
    expect(out.data[3]).toBe(0);
    expect(out.data[7]).toBe(255);
    expect(out.data[11]).toBe(255);
    // colour channels are carried through untouched
    expect(Array.from(out.data.slice(8, 11))).toEqual([0, 0, 255]);
  });

  it('feathers brightness through the key band', () => {
    const r = rgba(1, 1, [[40, 40, 40, 255]]); // brightness 40, mid-band
    const out = keyBlackToAlpha(r);
    expect(out.data[3]).toBeGreaterThan(0);
    expect(out.data[3]).toBeLessThan(255);
  });

  it('round-trips a matte: transparent stays transparent, bright stays opaque', () => {
    const original = rgba(1, 2, [
      [220, 180, 90, 0], // transparent
      [220, 180, 90, 255], // opaque content
    ]);
    const restored = keyBlackToAlpha(matteOnBlack(original));
    expect(restored.data[3]).toBe(0); // was transparent
    expect(restored.data[7]).toBe(255); // was opaque
    expect(Array.from(restored.data.slice(4, 7))).toEqual([220, 180, 90]);
  });
});

describe('matteTransparentPng', () => {
  it('mattes a PNG with enough transparency and reports it', () => {
    // half the pixels transparent → well over the 2% floor
    const r = rgba(1, 2, [
      [10, 200, 30, 0],
      [10, 200, 30, 255],
    ]);
    const result = matteTransparentPng(pngOf(r));
    expect(result.matted).toBe(true);
    const decoded = decode(result.bytes);
    expect(decoded.channels).toBe(3); // alpha dropped
    expect(Array.from((decoded.data as Uint8Array).slice(0, 3))).toEqual([
      0, 0, 0,
    ]);
  });

  it('leaves a fully-opaque PNG untouched', () => {
    const r = rgba(1, 2, [
      [10, 20, 30, 255],
      [40, 50, 60, 255],
    ]);
    const bytes = pngOf(r);
    const result = matteTransparentPng(bytes);
    expect(result.matted).toBe(false);
    expect(result.bytes).toBe(bytes); // identity — no re-encode
  });

  it('ignores transparency below the fraction floor', () => {
    // one transparent pixel out of 100 = 1% < 2% floor
    const pixels = Array.from({ length: 100 }, (_, i) =>
      i === 0 ? [0, 0, 0, 0] : [10, 20, 30, 255],
    );
    const bytes = pngOf(rgba(10, 10, pixels));
    expect(matteTransparentPng(bytes).matted).toBe(false);
  });

  it('leaves non-PNG bytes untouched', () => {
    const junk = new Uint8Array([1, 2, 3, 4]);
    const result = matteTransparentPng(junk);
    expect(result.matted).toBe(false);
    expect(result.bytes).toBe(junk);
  });
});

describe('restoreTransparency', () => {
  it('keys the model output back to RGBA with transparent black', () => {
    // bright text on a black background, as gpt-image-2 would return a matte
    const out = matteOnBlack(
      rgba(1, 2, [
        [230, 210, 250, 0], // background
        [230, 210, 250, 255], // content
      ]),
    );
    const restored = decode(restoreTransparency(pngOf(out)));
    expect(restored.channels).toBe(4);
    const data = restored.data as Uint8Array;
    expect(data[3]).toBe(0); // background keyed transparent
    expect(data[7]).toBe(255); // content stays opaque
  });

  it('returns the input unchanged on undecodable bytes', () => {
    const junk = new Uint8Array([9, 9, 9]);
    expect(restoreTransparency(junk)).toBe(junk);
  });
});
