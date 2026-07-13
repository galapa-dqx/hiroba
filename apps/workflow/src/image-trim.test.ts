import { encode } from 'fast-png';
import { describe, expect, it } from 'vitest';

import {
  alphaContentBox,
  contentBox,
  crop,
  fitAspect,
  imageDimensions,
  originalGeometry,
  restoreMargins,
  trimToAspect,
  type Raster,
} from './image-trim';

/** Solid-white RGBA raster. */
function whiteRaster(width: number, height: number): Raster {
  const data = new Uint8Array(width * height * 4).fill(255);
  return { data, width, height, channels: 4 };
}

/** Fully transparent RGBA raster (zeroed). */
function transparentRaster(width: number, height: number): Raster {
  return {
    data: new Uint8Array(width * height * 4),
    width,
    height,
    channels: 4,
  };
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

  it('treats transparent padding as background (restored-matte case)', () => {
    // fully transparent frame with an opaque dark block — dark RGB alone would
    // read as content, so alpha is what marks the padding as background.
    const r: Raster = {
      data: new Uint8Array(6 * 6 * 4), // all zero → transparent black
      width: 6,
      height: 6,
      channels: 4,
    };
    fillRect(r, 2, 1, 2, 3, [10, 10, 10]); // opaque (alpha 255) dark content
    expect(contentBox(r)).toEqual({ x: 2, y: 1, width: 2, height: 3 });
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

  it('leaves a near-match within tolerance unchanged (no sliver crop)', () => {
    // 101×100 is 1% off square — inside the default 3% band, so keep it as-is
    // rather than trimming a 1px sliver.
    expect(fitAspect({ x: 0, y: 0, width: 101, height: 100 }, 1)).toEqual({
      x: 0,
      y: 0,
      width: 101,
      height: 100,
    });
  });

  it('still crops once the drift exceeds tolerance', () => {
    // 110×100 is 10% off square — outside the band, so center-crop to square.
    expect(fitAspect({ x: 0, y: 0, width: 110, height: 100 }, 1)).toEqual({
      x: 5,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it('honors an explicit tolerance', () => {
    // Same 10% drift, but a 20% tolerance keeps it untouched.
    expect(fitAspect({ x: 0, y: 0, width: 110, height: 100 }, 1, 0.2)).toEqual({
      x: 0,
      y: 0,
      width: 110,
      height: 100,
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

describe('alphaContentBox', () => {
  it('finds the visible box of an RGBA raster', () => {
    const r = transparentRaster(10, 6);
    fillRect(r, 2, 1, 5, 3, [30, 60, 90]);
    expect(alphaContentBox({ ...r, depth: 8 })).toEqual({
      x: 2,
      y: 1,
      width: 5,
      height: 3,
    });
  });

  it('reads indexed transparency through the tRNS table', () => {
    // 4×2 indexed raster: index 0 transparent, index 1 opaque
    const data = Uint8Array.from([0, 1, 1, 0, 0, 1, 0, 0]);
    expect(
      alphaContentBox({
        data,
        width: 4,
        height: 2,
        channels: 1,
        depth: 8,
        palette: [
          [0, 0, 0],
          [255, 0, 0],
        ],
        transparency: Uint16Array.from([0, 255]),
      }),
    ).toEqual({ x: 1, y: 0, width: 2, height: 2 });
  });

  it('returns null when there is no alpha to measure', () => {
    const rgb: Raster = {
      data: new Uint8Array(4 * 4 * 3),
      width: 4,
      height: 4,
      channels: 3,
    };
    expect(alphaContentBox({ ...rgb, depth: 8 })).toBeNull();
    expect(
      alphaContentBox({ ...transparentRaster(4, 4), depth: 8 }),
    ).toBeNull();
  });
});

describe('originalGeometry', () => {
  it('reports transparent edge margins as a content box', () => {
    const r = transparentRaster(20, 4);
    fillRect(r, 0, 1, 8, 2, [10, 20, 30]); // artwork hugs the left edge
    expect(originalGeometry(pngOf(r))).toEqual({
      width: 20,
      height: 4,
      content: { x: 0, y: 1, width: 8, height: 2 },
    });
  });

  it('reports no content box for an opaque image', () => {
    expect(originalGeometry(pngOf(whiteRaster(8, 4)))).toEqual({
      width: 8,
      height: 4,
      content: null,
    });
  });
});

describe('restoreMargins', () => {
  it('re-adds the original margins scaled to the content growth', () => {
    // original: 20×4 canvas, content at (0,1) 8×2 → margins L0 T1 R12 B1.
    // localized content came back 2× (16×4) → margins L0 T2 R24 B2.
    const content = { x: 0, y: 1, width: 8, height: 2 };
    const localized = whiteRaster(16, 4);
    const padded = restoreMargins(localized, { width: 20, height: 4 }, content);
    expect([padded.width, padded.height]).toEqual([40, 8]);
    expect(padded.data[3]).toBe(0); // top-left margin transparent
    expect(padded.data[(2 * 40 + 0) * 4 + 3]).toBe(255); // content row opaque
    expect(padded.data[(2 * 40 + 20) * 4 + 3]).toBe(0); // right margin transparent
  });

  it('scales each axis independently when content growth is uneven', () => {
    // content 8×2 came back 16×5 (sx 2, sy 2.5 — aspect drift fitAspect kept):
    // horizontal margins scale by 2, vertical by 2.5.
    const content = { x: 2, y: 1, width: 8, height: 2 };
    const localized = whiteRaster(16, 5);
    const padded = restoreMargins(localized, { width: 20, height: 4 }, content);
    // L 2×2=4, R 10×2=20 → width 40; T 1×2.5→3, B 1×2.5→3 → height 11
    expect([padded.width, padded.height]).toEqual([40, 11]);
  });

  it('promotes RGB input to RGBA with opaque content', () => {
    const rgb: Raster = {
      data: new Uint8Array(2 * 2 * 3).fill(9),
      width: 2,
      height: 2,
      channels: 3,
    };
    const padded = restoreMargins(
      rgb,
      { width: 4, height: 2 },
      { x: 1, y: 0, width: 2, height: 2 },
    );
    expect([padded.width, padded.height, padded.channels]).toEqual([4, 2, 4]);
    expect(padded.data[3]).toBe(0); // left margin transparent
    expect([padded.data[4], padded.data[7]]).toEqual([9, 255]); // content, opaque
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

  it('fits a transparency-padded original by content aspect and restores its margins', () => {
    // Original like ttl_online.png: 20×4 canvas, artwork only at (0,1) 8×2 —
    // canvas aspect 5.0, content aspect 4.0. The matte round trip returns just
    // the artwork (2× scale, transparent padding); fitting that against the
    // canvas aspect would crop into it.
    const original = transparentRaster(20, 4);
    fillRect(original, 0, 1, 8, 2, [10, 20, 30]);

    const recovered = transparentRaster(24, 8);
    fillRect(recovered, 4, 2, 16, 4, [10, 20, 30]);

    const result = trimToAspect(pngOf(recovered), pngOf(original));
    // content kept whole (16×4), margins re-inserted at 2×: L0 T2 R24 B2
    expect(imageDimensions(result)).toEqual({ width: 40, height: 8 });
  });
});
