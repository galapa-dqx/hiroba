/**
 * Derived-file generation for a render (DQX-49) — the write-side half of the
 * `<picture>` the web emits.
 *
 * Every raster we store keeps its byte-exact primary object; beside it this
 * writes an AVIF re-encode at `<key>.avif` and a fixed ladder of downscaled
 * renditions at `<key>.fit<W>x<H>.<ext>`, each in both the source format and
 * AVIF (see avifVariantKey / fitVariantKey in @hiroba/shared). Each one
 * becomes a non-primary `image_files` row: the MIME + width/height the
 * renderer turns into `<picture>` sources and `w`-descriptor srcsets.
 *
 * The ladder is backend-driven — every render gets the same rungs, derived
 * from its own dimensions, so no caller has to know anything about layout.
 * The frontend picks from what's recorded using its own `sizes` hint.
 *
 * Every derived file is best-effort and RECORDED, never assumed — a
 * `<source>` that 404s does not fall back to the `<img>`, so a row is the only
 * evidence an object exists. Skips: GIFs (Cloudflare Images won't produce
 * animated AVIF, and resizing would eat the animation), formats we can't
 * sniff, rungs that round away to nothing on a tiny raster, and any output
 * that comes out no smaller than the primary. Whatever survives is the
 * render's file set.
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
type DerivableSource = 'image/png' | 'image/jpeg' | 'image/webp';
const DERIVABLE_SOURCE_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/webp',
]);

/** Narrows a sniffed MIME to a source we'll re-encode — the one gate every
 *  derived file passes, so downstream code (and fitVariantKey's extension
 *  lookup) only ever sees formats we know. */
const isDerivableSource = (mime: string): mime is DerivableSource =>
  DERIVABLE_SOURCE_TYPES.has(mime);

/**
 * WebP's animation flag: a VP8X chunk directly after the RIFF/WEBP header,
 * with bit 1 of its feature byte set. Animated WebP is the same hazard the
 * GIF exclusion names, wearing a different container: the Images binding's
 * `anim` default preserves animation for WebP OUTPUT, but AVIF output is
 * still-only — and a frozen first frame sails through the smaller-than-primary
 * gate precisely because it dropped every other frame.
 */
function isAnimatedWebP(b: Uint8Array): boolean {
  return (
    b.length > 20 &&
    b[12] === 0x56 && // "VP8X"
    b[13] === 0x50 &&
    b[14] === 0x38 &&
    b[15] === 0x58 &&
    ((b[20] ?? 0) & 0x02) !== 0
  );
}

/** What an encode may emit: a rendition in the source's own format, or AVIF. */
type EncodeFormat = DerivableSource | 'image/avif';

/**
 * The rendition ladder, as fractions of the primary's own dimensions. 1x is
 * the primary itself (and its full-size AVIF), which every render already
 * gets, so the ladder only names the smaller rungs — listing 1x here would
 * just re-encode the primary at its own size.
 */
const RENDITION_SCALES = [0.5, 0.25];

export type DeriveOptions = {
  /** MIME to record when the Images binding can't decode the bytes and the
   *  magic-byte sniff comes up empty (an upstream header, an upload's type). */
  fallbackMime?: string | null;
};

/**
 * The ladder for a raster of `measured` size: each scale rounded to whole
 * pixels, minus the rungs that don't survive contact with a small raster.
 *
 * Two rungs of a small raster can round to the SAME box (2px wide: 0.5x and
 * 0.25x both land on 1px), and a box is keyed by its dimensions — so without
 * deduping here the render would try to insert one key twice and lose the
 * whole atomic batch. A rung at the primary's own size is dropped for the same
 * reason it isn't in RENDITION_SCALES: it's the primary.
 */
function ladder(measured: Measured): FitSize[] {
  if (measured.width === null || measured.height === null) return [];
  const seen = new Set<string>();
  const rungs: FitSize[] = [];
  for (const scale of RENDITION_SCALES) {
    const width = Math.round(measured.width * scale);
    const height = Math.round(measured.height * scale);
    if (width < 1 || height < 1) continue;
    if (width >= measured.width && height >= measured.height) continue;
    const box = `${width}x${height}`;
    if (seen.has(box)) continue;
    seen.add(box);
    rungs.push({ width, height });
  }
  return rungs;
}

/**
 * Run one Images transform chain and keep the result only if it beat the
 * primary's size — the "no derived file is better than a bigger one" rule
 * every encode here shares. Null means "nothing to record", never an error.
 */
async function encode(
  images: ImagesBinding,
  bytes: Uint8Array,
  format: EncodeFormat,
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
    const result = await input.output({ format });
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
 * `image_files` rows. `measured` is the primary's own measurement — both the
 * byte size the skip rule compares against and the dimensions the ladder is
 * scaled from.
 *
 * Never throws: neither a failed encode NOR a failed store may cost the caller
 * its render, since every file here is optional. A render that loses all of
 * them simply serves as a bare `<img>`.
 */
async function deriveFiles(
  images: ImagesBinding,
  bucket: R2Bucket,
  primaryKey: string,
  bytes: Uint8Array,
  measured: Measured,
  cacheControl: string,
): Promise<RenderFileInput[]> {
  const sniffed = sniffMimeType(bytes);
  // Only rasters we can safely re-encode; everything else keeps its primary
  // alone (an SVG, an animated GIF, a format the sniff doesn't know). An
  // animated WebP is a GIF in a newer coat — see isAnimatedWebP.
  if (!sniffed || !isDerivableSource(sniffed)) return [];
  if (sniffed === 'image/webp' && isAnimatedWebP(bytes)) return [];

  /** One encode→store→measure chain; null when skipped or failed. */
  const derive = async (
    format: EncodeFormat,
    size?: FitSize,
  ): Promise<RenderFileInput | null> => {
    const out = await encode(images, bytes, format, size);
    if (!out) return null;
    const key = size
      ? fitVariantKey(primaryKey, size, format)
      : avifVariantKey(primaryKey);
    try {
      await bucket.put(key, out, {
        httpMetadata: { contentType: format, cacheControl },
      });
      // Resized outputs are re-measured rather than computed: Cloudflare owns
      // the scale-down rounding, and a row's dimensions must match its bytes.
      const dims = size ? await measureImage(images, out) : measured;
      return {
        key,
        isPrimary: false,
        mime: format,
        width: dims.width,
        height: dims.height,
        bytes: out.byteLength,
      };
    } catch (err) {
      // A failed store is the same outcome as a failed encode: one fewer file
      // to offer. Letting it escape would cost the caller the whole render —
      // a localize that already paid for gpt-image-2 and stored its primary
      // would report `failed` and record nothing over an OPTIONAL file. A row
      // is only returned once the object is durably stored, so a reader never
      // learns about an object that isn't there.
      console.error(`derived file store failed for ${key}:`, err);
      return null;
    }
  };

  // The full-size AVIF, then each smaller rung in both formats — so a browser
  // that takes the AVIF <source> has the same ladder to choose from as one
  // falling back to the primary's format.
  const specs: Array<[EncodeFormat, FitSize?]> = [['image/avif', undefined]];
  for (const size of ladder(measured)) {
    specs.push([sniffed, size], ['image/avif', size]);
  }
  // The chains are independent — distinct keys by construction, read-only
  // input, no chain ever throws — so they run concurrently: sequentially this
  // was up to ~14 serialized Images/R2 round-trips, the whole tail of the
  // per-image child flows. Collecting by spec index keeps the row order
  // deterministic regardless of which chain finishes first.
  const results = await Promise.all(specs.map(([f, s]) => derive(f, s)));
  return results.filter((r): r is RenderFileInput => r !== null);
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
  );
  return [primary, ...derived];
}

/**
 * The derived files alone, for a render whose primary row already exists
 * (ImageFileFlow's register step, over an admin upload). Measures the bytes
 * itself, since the recorded primary may predate measurement. Takes no
 * fallback MIME: only the primary row ever needs one, and that row is already
 * written by the time this runs.
 */
export async function buildDerivedFiles(
  images: ImagesBinding,
  bucket: R2Bucket,
  primaryKey: string,
  bytes: Uint8Array,
  cacheControl: string,
): Promise<RenderFileInput[]> {
  const measured = await measureImage(images, bytes);
  return deriveFiles(images, bucket, primaryKey, bytes, measured, cacheControl);
}
