/**
 * buildRenderFiles against a scripted fake ImagesBinding — locks the derived
 * file rules: a full-size AVIF beside the primary, fit-inside renditions in
 * source format + AVIF per requested size, and the skips (a raster already
 * inside the box, an output no smaller than the primary, a non-raster source).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDerivedFiles, buildRenderFiles } from './image-files';

/** Bytes with a real PNG magic so sniffMimeType sees a raster. */
const pngBytes = (length: number): Uint8Array => {
  const b = new Uint8Array(length);
  b.set([0x89, 0x50, 0x4e, 0x47]);
  return b;
};

/** Bytes with a GIF magic — the "never re-encode" source. */
const gifBytes = (length: number): Uint8Array => {
  const b = new Uint8Array(length);
  b.set([0x47, 0x49, 0x46]);
  return b;
};

/**
 * A fake ImagesBinding driven by two queues: `info` results (the first call
 * measures the primary, later calls measure resized outputs) and transform
 * `outputs` (consumed in encode order: full AVIF, then per size
 * source-format → AVIF).
 */
const makeImages = (info: unknown[], outputs: Uint8Array[]) => {
  const output = vi.fn(async () => ({
    response: () => new Response(outputs.shift()),
  }));
  return {
    info: vi.fn(async () => {
      const next = info.shift();
      if (!next) throw new Error('unmeasurable');
      return next;
    }),
    input: vi.fn(() => ({
      output,
      transform: vi.fn(() => ({ output })),
    })),
  } as unknown as ImagesBinding;
};

const makeBucket = () =>
  ({ put: vi.fn(), delete: vi.fn() }) as unknown as R2Bucket;

const pngInfo = (width: number, height: number) => ({
  format: 'image/png',
  fileSize: 1,
  width,
  height,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildRenderFiles', () => {
  it('returns primary + full AVIF + the 0.5x/0.25x ladder in both formats', async () => {
    const images = makeImages(
      [
        pngInfo(800, 600), // primary
        pngInfo(400, 300), // .5x png
        pngInfo(400, 300), // .5x avif
        pngInfo(200, 150), // .25x png
        pngInfo(200, 150), // .25x avif
      ],
      [
        pngBytes(300),
        pngBytes(500),
        pngBytes(200),
        pngBytes(150),
        pngBytes(80),
      ],
    );
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
    );

    // Objects land before the rows that name them. The ladder is derived from
    // the primary's own dimensions — no caller asked for these boxes.
    expect(vi.mocked(bucket.put).mock.calls.map((c) => c[0])).toEqual([
      'g/a.png.avif',
      'g/a.png.fit400x300.png',
      'g/a.png.fit400x300.avif',
      'g/a.png.fit200x150.png',
      'g/a.png.fit200x150.avif',
    ]);
    expect(files).toEqual([
      {
        key: 'g/a.png',
        isPrimary: true,
        mime: 'image/png',
        width: 800,
        height: 600,
        bytes: 1000,
      },
      {
        key: 'g/a.png.avif',
        isPrimary: false,
        mime: 'image/avif',
        // The full-size AVIF inherits the primary's measurement.
        width: 800,
        height: 600,
        bytes: 300,
      },
      {
        key: 'g/a.png.fit400x300.png',
        isPrimary: false,
        mime: 'image/png',
        // Renditions are re-measured — Cloudflare owns the scale-down rounding.
        width: 400,
        height: 300,
        bytes: 500,
      },
      {
        key: 'g/a.png.fit400x300.avif',
        isPrimary: false,
        mime: 'image/avif',
        width: 400,
        height: 300,
        bytes: 200,
      },
      {
        key: 'g/a.png.fit200x150.png',
        isPrimary: false,
        mime: 'image/png',
        width: 200,
        height: 150,
        bytes: 150,
      },
      {
        key: 'g/a.png.fit200x150.avif',
        isPrimary: false,
        mime: 'image/avif',
        width: 200,
        height: 150,
        bytes: 80,
      },
    ]);
  });

  it('drops every encode that came out no smaller than the primary', async () => {
    // Five attempts (full AVIF + two rungs × two formats), all bloating.
    const images = makeImages(
      Array.from({ length: 5 }, () => pngInfo(64, 64)),
      Array.from({ length: 5 }, () => pngBytes(900)),
    );
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/icon.png',
      pngBytes(800),
      'cc',
    );

    expect(files).toHaveLength(1);
    expect(files[0]?.isPrimary).toBe(true);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('collapses rungs that round onto the same box', async () => {
    // 2x2: BOTH 0.5x and 0.25x round to 1x1. Emitting both would try to insert
    // one key twice and take the render's whole atomic batch down with it.
    const images = makeImages(
      [pngInfo(2, 2), pngInfo(1, 1), pngInfo(1, 1)],
      [pngBytes(300), pngBytes(200), pngBytes(100)],
    );
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/tiny.png',
      pngBytes(1000),
      'cc',
    );

    expect(files.map((f) => f.key)).toEqual([
      'g/tiny.png',
      'g/tiny.png.avif',
      'g/tiny.png.fit1x1.png',
      'g/tiny.png.fit1x1.avif',
    ]);
    expect(new Set(files.map((f) => f.key)).size).toBe(files.length);
  });

  it('builds no ladder for a 1x1 raster — every rung would be the primary', async () => {
    const images = makeImages([pngInfo(1, 1)], [pngBytes(300)]);
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/px.png',
      pngBytes(1000),
      'cc',
    );

    expect(files.map((f) => f.key)).toEqual(['g/px.png', 'g/px.png.avif']);
  });

  it('builds no ladder when the primary could not be measured', async () => {
    // The binding decodes nothing, so there are no dimensions to scale from —
    // but the magic bytes still say PNG, so the full-size AVIF is attempted.
    const images = makeImages([], [pngBytes(300)]);
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
    );

    expect(files.map((f) => f.key)).toEqual(['g/a.png', 'g/a.png.avif']);
  });

  it('never re-encodes a GIF (animation) but still records the primary', async () => {
    const images = makeImages(
      [{ format: 'image/gif', fileSize: 1, width: 100, height: 100 }],
      [],
    );
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.gif',
      gifBytes(1000),
      'cc',
    );

    expect(files).toEqual([
      {
        key: 'g/a.gif',
        isPrimary: true,
        mime: 'image/gif',
        width: 100,
        height: 100,
        bytes: 1000,
      },
    ]);
    expect(bucket.put).not.toHaveBeenCalled();
  });

  it('records an undecodable primary with the caller-supplied fallback mime', async () => {
    // Empty info queue → the binding throws → measureImage returns nulls, and
    // the bytes have no sniffable magic either.
    const images = makeImages([], []);
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.svg',
      new Uint8Array([0x3c, 0x73, 0x76, 0x67]),
      'cc',
      { fallbackMime: 'image/svg+xml' },
    );

    expect(files).toEqual([
      {
        key: 'g/a.svg',
        isPrimary: true,
        mime: 'image/svg+xml',
        width: null,
        height: null,
        bytes: 4,
      },
    ]);
  });

  it('survives a failing encode — the render just serves as a bare <img>', async () => {
    const images = {
      info: vi.fn(async () => pngInfo(800, 600)),
      input: vi.fn(() => ({
        output: vi.fn(async () => {
          throw new Error('transform unavailable');
        }),
      })),
    } as unknown as ImagesBinding;
    const bucket = makeBucket();

    const files = await buildRenderFiles(
      images,
      bucket,
      'g/a.png',
      pngBytes(1000),
      'cc',
    );

    expect(files.map((f) => f.key)).toEqual(['g/a.png']);
  });
});

describe('buildDerivedFiles', () => {
  it('returns only the derived rows, for a render whose primary already exists', async () => {
    const images = makeImages(
      [
        pngInfo(800, 600),
        pngInfo(400, 300),
        pngInfo(400, 300),
        pngInfo(200, 150),
        pngInfo(200, 150),
      ],
      [
        pngBytes(300),
        pngBytes(500),
        pngBytes(200),
        pngBytes(150),
        pngBytes(80),
      ],
    );
    const bucket = makeBucket();

    const files = await buildDerivedFiles(
      images,
      bucket,
      'l10n/en/v1/g/a.png',
      pngBytes(1000),
      'cc',
    );

    // No primary row — that one already exists on the render.
    expect(files.every((f) => !f.isPrimary)).toBe(true);
    expect(files.map((f) => f.key)).toEqual([
      'l10n/en/v1/g/a.png.avif',
      'l10n/en/v1/g/a.png.fit400x300.png',
      'l10n/en/v1/g/a.png.fit400x300.avif',
      'l10n/en/v1/g/a.png.fit200x150.png',
      'l10n/en/v1/g/a.png.fit200x150.avif',
    ]);
  });
});
