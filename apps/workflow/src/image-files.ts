/**
 * Derived-file generation for a render (DQX-49) — the write-side half of the
 * `<picture>` the web emits.
 *
 * Every raster we store keeps its byte-exact primary object; beside it this
 * writes an AVIF re-encode at `<key>.avif` and, when a caller asks for them,
 * fit-inside renditions at `<key>.fit<W>x<H>.<ext>` in both the source format
 * and AVIF (see avifVariantKey / fitVariantKey in @hiroba/shared). Each one
 * becomes a non-primary `image_files` row: the MIME + width/height the
 * renderer reads to decide what it may offer.
 *
 * Every derived file is best-effort and RECORDED, never assumed — a
 * `<source>` that 404s does not fall back to the `<img>`, so a row is the only
 * evidence an object exists. Skips: GIFs (Cloudflare Images won't produce
 * animated AVIF, and resizing would eat the animation), formats we can't
 * sniff, boxes the raster already fits inside, and any output that comes out
 * no smaller than the primary. Whatever survives is the render's file set.
 *
 * Callers write these into the render's ONE atomic insert (mirror, localize),
 * or — for renders written outside this worker — hand the image id to
 * ImageFileFlow, which lands them with replaceDerivedFiles.
 */

import type { RenderFileInput } from '@hiroba/db';
import {
  avifVariantKey,
  fitVariantKey,
  measureImage,
  type FitSize,
  type Measured,
} from '@hiroba/shared';

import { sniffMimeType } from './image-edit';

/** Source formats worth re-encoding. GIF is excluded: it's animated more
 *  often than not on the DQX CDN, and a still/resized re-encode would break
 *  the animation. */
const DERIVABLE_SOURCE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

export type DeriveOptions = {
  /** MIME to record when the Images binding can't decode the bytes and the
   *  magic-byte sniff comes up empty (an upstream header, an upload's type). */
  fallbackMime?: string | null;
  /** Fit-inside boxes to render thumbnails for (DQX-48 consumes them); each
   *  produces a source-format and an AVIF rendition. */
  sizes?: FitSize[];
};

/**
 * Run one Images transform chain and keep the result only if it beat the
 * primary's size — the "no derived file is better than a bigger one" rule
 * every encode here shares. Null means "nothing to record", never an error.
 */
async function encode(
  images: ImagesBinding,
  bytes: Uint8Array,
  format: string,
  size?: FitSize,
): Promise<Uint8Array | null> {
  try {
    let input = images.input(
      new Response(bytes as BodyInit).body as ReadableStream<Uint8Array>,
    );
    // scale-down = fit inside the box, never enlarge.
    if (size) {
      input = input.transform({
        width: size.width,
        height: size.height,
        fit: 'scale-down',
      });
    }
    const result = await input.output({ format: format as 'image/avif' });
    const out = new Uint8Array(await result.response().arrayBuffer());
    return out.byteLength < bytes.byteLength ? out : null;
  } catch (err) {
    console.error(
      `image encode failed (${format}${size ? ` fit ${size.width}x${size.height}` : ''}):`,
      err,
    );
    return null;
  }
}

/**
 * Encode and store every derived object for a primary raster, returning their
 * `image_files` rows. `measured` is the primary's own measurement (the size
 * and dimensions the skip rules compare against). Never throws for one bad
 * encode: a render with no derived files simply serves as a bare `<img>`.
 */
async function deriveFiles(
  images: ImagesBinding,
  bucket: R2Bucket,
  primaryKey: string,
  bytes: Uint8Array,
  measured: Measured,
  cacheControl: string,
  opts: DeriveOptions,
): Promise<RenderFileInput[]> {
  const sniffed = sniffMimeType(bytes);
  // Only rasters we can safely re-encode; everything else keeps its primary
  // alone (an SVG, an animated GIF, a format the sniff doesn't know).
  if (!sniffed || !DERIVABLE_SOURCE_TYPES.has(sniffed)) return [];

  const rows: RenderFileInput[] = [];
  const add = async (format: string, size?: FitSize): Promise<void> => {
    const out = await encode(images, bytes, format, size);
    if (!out) return;
    const key = size
      ? fitVariantKey(primaryKey, size, format)
      : avifVariantKey(primaryKey);
    await bucket.put(key, out, {
      httpMetadata: { contentType: format, cacheControl },
    });
    // Resized outputs are re-measured rather than computed: Cloudflare owns
    // the scale-down rounding, and a row's dimensions must match its bytes.
    const dims = size ? await measureImage(images, out) : measured;
    rows.push({
      key,
      isPrimary: false,
      mime: format,
      width: dims.width,
      height: dims.height,
      bytes: out.byteLength,
    });
  };

  await add('image/avif');
  for (const size of opts.sizes ?? []) {
    // A raster already inside the box has nothing to shrink — a "resized"
    // rendition would just be a lossy re-encode at the same dimensions, which
    // the renderer would then be free to mistake for a full-size alternate.
    if (measured.width === null || measured.height === null) continue;
    if (measured.width <= size.width && measured.height <= size.height)
      continue;
    await add(sniffed, size);
    await add('image/avif', size);
  }
  return rows;
}

/**
 * The complete file set for a NEW render — its measured primary first, then
 * every derived file (objects already written to R2). Callers pass the result
 * straight to `insertImageRender`, so the render lands complete-at-birth in
 * one atomic batch.
 */
export async function buildRenderFiles(
  images: ImagesBinding,
  bucket: R2Bucket,
  primaryKey: string,
  bytes: Uint8Array,
  cacheControl: string,
  opts: DeriveOptions = {},
): Promise<RenderFileInput[]> {
  const measured = await measureImage(images, bytes);
  const primary: RenderFileInput = {
    key: primaryKey,
    isPrimary: true,
    mime: measured.mime ?? sniffMimeType(bytes) ?? opts.fallbackMime ?? null,
    width: measured.width,
    height: measured.height,
    bytes: bytes.byteLength,
  };
  const derived = await deriveFiles(
    images,
    bucket,
    primaryKey,
    bytes,
    measured,
    cacheControl,
    opts,
  );
  return [primary, ...derived];
}

/**
 * The derived files alone, for a render whose primary row already exists
 * (ImageFileFlow's register step, over an admin upload). Measures the bytes
 * itself, since the recorded primary may predate measurement.
 */
export async function buildDerivedFiles(
  images: ImagesBinding,
  bucket: R2Bucket,
  primaryKey: string,
  bytes: Uint8Array,
  cacheControl: string,
  opts: DeriveOptions = {},
): Promise<RenderFileInput[]> {
  const measured = await measureImage(images, bytes);
  return deriveFiles(
    images,
    bucket,
    primaryKey,
    bytes,
    measured,
    cacheControl,
    opts,
  );
}
