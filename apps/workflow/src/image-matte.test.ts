import { decode, encode } from 'fast-png';
import { describe, expect, it } from 'vitest';

import {
  decodedHasMeaningfulTransparency,
  estimateShift,
  findSplitRow,
  hasMeaningfulTransparency,
  recoverAlphaFromTwoUp,
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

/**
 * A textured test foreground with soft alpha, on a transparent ground:
 * an opaque two-colour checker rect plus a half-transparent solid strip.
 */
const FG_W = 120;
const FG_H = 88;
const RECT = { x: 20, y: 16, w: 80, h: 48 };
const STRIP = { x: 20, y: 70, w: 80, h: 10, alpha: 128 };

function testForeground(): Raster {
  const r = rgba(FG_W, FG_H, []);
  for (let y = RECT.y; y < RECT.y + RECT.h; y++) {
    for (let x = RECT.x; x < RECT.x + RECT.w; x++) {
      const p = (y * FG_W + x) * 4;
      const check = ((x >> 2) + (y >> 2)) % 2 === 0;
      r.data.set(check ? [200, 80, 40, 255] : [40, 120, 220, 255], p);
    }
  }
  for (let y = STRIP.y; y < STRIP.y + STRIP.h; y++) {
    for (let x = STRIP.x; x < STRIP.x + STRIP.w; x++) {
      r.data.set([120, 220, 90, STRIP.alpha], (y * FG_W + x) * 4);
    }
  }
  return r;
}

/** Composite `fg` over a solid background into `canvas` at (ox, oy). */
function compositeAt(
  canvas: Raster,
  fg: Raster,
  ox: number,
  oy: number,
  bg: [number, number, number],
): void {
  for (let y = 0; y < fg.height; y++) {
    for (let x = 0; x < fg.width; x++) {
      const s = (y * fg.width + x) * 4;
      const a = fg.data[s + 3];
      const d = ((oy + y) * canvas.width + (ox + x)) * canvas.channels;
      for (let c = 0; c < 3; c++) {
        canvas.data[d + c] = Math.round(
          (fg.data[s + c] * a + bg[c] * (255 - a)) / 255,
        );
      }
    }
  }
}

/** Solid-colour RGB raster. */
function solid(
  width: number,
  height: number,
  [r, g, b]: [number, number, number],
): Raster {
  const data = new Uint8Array(width * height * 3);
  for (let p = 0; p < data.length; p += 3) data.set([r, g, b], p);
  return { data, width, height, channels: 3 };
}

/** Stack two same-width rasters vertically. */
function stack(top: Raster, bot: Raster): Raster {
  const data = new Uint8Array(top.data.length + bot.data.length);
  data.set(top.data, 0);
  data.set(bot.data, top.data.length);
  return {
    data,
    width: top.width,
    height: top.height + bot.height,
    channels: top.channels,
  };
}

/**
 * A synthetic two-up render: the test foreground over black on top and over
 * white below, with the bottom copy offset by (offY, offX) — as if the model
 * hadn't lined the copies up perfectly.
 */
function twoUp(offY: number, offX: number): Raster {
  const fg = testForeground();
  const top = solid(220, 170, [0, 0, 0]);
  const bot = solid(220, 170, [255, 255, 255]);
  compositeAt(top, fg, 44, 40, [0, 0, 0]);
  compositeAt(bot, fg, 44 + offX, 40 + offY, [255, 255, 255]);
  return stack(top, bot);
}

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

describe('hasMeaningfulTransparency', () => {
  it('is true for a PNG with enough see-through pixels', () => {
    // half the pixels transparent → well over the 2% floor
    const r = rgba(2, 2, [
      [10, 200, 30, 0],
      [10, 200, 30, 0],
      [10, 200, 30, 255],
      [10, 200, 30, 255],
    ]);
    expect(hasMeaningfulTransparency(pngOf(r))).toBe(true);
  });

  it('is false for a fully-opaque PNG', () => {
    const r = rgba(1, 2, [
      [10, 20, 30, 255],
      [40, 50, 60, 255],
    ]);
    expect(hasMeaningfulTransparency(pngOf(r))).toBe(false);
  });

  it('is false below the fraction floor', () => {
    // one transparent pixel out of 100 = 1% < 2% floor
    const pixels = Array.from({ length: 100 }, (_, i) =>
      i === 0 ? [0, 0, 0, 0] : [10, 20, 30, 255],
    );
    expect(hasMeaningfulTransparency(pngOf(rgba(10, 10, pixels)))).toBe(false);
  });

  it('is false for non-PNG bytes', () => {
    expect(hasMeaningfulTransparency(new Uint8Array([1, 2, 3, 4]))).toBe(false);
  });
});

describe('decodedHasMeaningfulTransparency (indexed PNGs)', () => {
  const palette: [number, number, number][] = [
    [255, 0, 0],
    [0, 255, 0],
  ];

  it('counts pixels whose tRNS entry is see-through', () => {
    // 10×10 indices, half pointing at a transparent palette entry
    const data = new Uint8Array(100);
    data.fill(1, 50); // entry 1 is transparent below
    expect(
      decodedHasMeaningfulTransparency({
        data,
        width: 10,
        height: 10,
        channels: 1,
        depth: 8,
        palette,
        transparency: new Uint16Array([255, 0]),
      }),
    ).toBe(true);
  });

  it('is false when the tRNS table is fully opaque', () => {
    expect(
      decodedHasMeaningfulTransparency({
        data: new Uint8Array(100),
        width: 10,
        height: 10,
        channels: 1,
        depth: 8,
        palette,
        transparency: new Uint16Array([255, 255]),
      }),
    ).toBe(false);
  });

  it('is false for an indexed PNG without a tRNS table', () => {
    expect(
      decodedHasMeaningfulTransparency({
        data: new Uint8Array(100),
        width: 10,
        height: 10,
        channels: 1,
        depth: 8,
        palette,
      }),
    ).toBe(false);
  });

  it('falls back to tRNS presence for bit-packed indices', () => {
    // depth 4: indices are packed, so any see-through entry counts
    const packed = {
      data: new Uint8Array(50),
      width: 10,
      height: 10,
      channels: 1,
      depth: 4 as const,
      palette,
    };
    expect(
      decodedHasMeaningfulTransparency({
        ...packed,
        transparency: new Uint16Array([255, 128]),
      }),
    ).toBe(true);
    expect(
      decodedHasMeaningfulTransparency({
        ...packed,
        transparency: new Uint16Array([255, 255]),
      }),
    ).toBe(false);
  });
});

describe('findSplitRow', () => {
  it('finds the black/white boundary of a stacked two-up', () => {
    const split = findSplitRow(twoUp(0, 0));
    expect(split).not.toBeNull();
    expect(Math.abs((split as number) - 170)).toBeLessThanOrEqual(1);
  });

  it('returns null when there is no black half', () => {
    expect(findSplitRow(solid(200, 200, [255, 255, 255]))).toBeNull();
  });
});

describe('estimateShift', () => {
  it('recovers a known offset between the halves', () => {
    const r = twoUp(3, 1);
    const rowBytes = r.width * r.channels;
    const top: Raster = {
      data: r.data.slice(0, 170 * rowBytes),
      width: r.width,
      height: 170,
      channels: r.channels,
    };
    const bot: Raster = {
      data: r.data.slice(170 * rowBytes),
      width: r.width,
      height: 170,
      channels: r.channels,
    };
    const shift = estimateShift(top, bot);
    expect(shift).not.toBeNull();
    // bottom content sits 3 down / 1 right ⇒ top[y] matches bot[y+3] ⇒ dy = −3
    expect(shift!.dy).toBeCloseTo(-3, 0);
    expect(shift!.dx).toBeCloseTo(-1, 0);
  });

  it('returns null when the halves share no artwork', () => {
    expect(
      estimateShift(
        solid(200, 100, [0, 0, 0]),
        solid(200, 100, [255, 255, 255]),
      ),
    ).toBeNull();
  });
});

describe('recoverAlphaFromTwoUp', () => {
  /** Alpha histogram buckets of a decoded RGBA image. */
  function alphaCounts(data: Uint8Array): {
    opaque: number;
    semi: number;
    clear: number;
  } {
    let opaque = 0;
    let semi = 0;
    let clear = 0;
    for (let p = 3; p < data.length; p += 4) {
      const a = data[p];
      if (a > 240) opaque++;
      else if (a === 0) clear++;
      else if (a > 108 && a < 148) semi++;
    }
    return { opaque, semi, clear };
  }

  it('recovers alpha and colour from a misaligned two-up', () => {
    const result = recoverAlphaFromTwoUp(pngOf(twoUp(3, 1)));
    expect(result).not.toBeNull();
    const decoded = decode(result!);
    expect(decoded.channels).toBe(4);
    const data = decoded.data as Uint8Array;
    const total = decoded.width * decoded.height;
    const { opaque, semi, clear } = alphaCounts(data);

    // the opaque checker rect survives at full alpha…
    expect(opaque).toBeGreaterThan(RECT.w * RECT.h * 0.9);
    // …the half-transparent strip lands near α=128…
    expect(semi).toBeGreaterThan(STRIP.w * STRIP.h * 0.7);
    // …and the background is genuinely transparent, not just faint
    expect(clear).toBeGreaterThan(
      (total - RECT.w * RECT.h - STRIP.w * STRIP.h) * 0.95,
    );

    // colour comes back too: opaque pixels average out between the two
    // checker colours (≈120, ≈100, ≈130), nowhere near black or white
    let r = 0;
    let n = 0;
    for (let p = 0; p < data.length; p += 4) {
      if (data[p + 3] > 240) {
        r += data[p];
        n++;
      }
    }
    expect(n).toBeGreaterThan(0);
    expect(r / n).toBeGreaterThan(80);
    expect(r / n).toBeLessThan(160);
  });

  it('returns null for a render that is not a two-up', () => {
    expect(
      recoverAlphaFromTwoUp(pngOf(solid(220, 340, [255, 255, 255]))),
    ).toBeNull();
  });

  it('returns null on undecodable bytes', () => {
    expect(recoverAlphaFromTwoUp(new Uint8Array([9, 9, 9]))).toBeNull();
  });
});
