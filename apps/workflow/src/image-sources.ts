/**
 * Variant registration for web-served images (mirrored originals and
 * localized renders). Every raster we store keeps its byte-exact primary
 * object; this measures it, best-effort re-encodes variants next to it —
 * a full-size AVIF at `<key>.avif` (avifVariantKey) and, when a caller asks,
 * resized fit-inside renditions at `<key>.fit<W>x<H><ext>` (fitVariantKey)
 * in both the source format and AVIF — and records the complete set as
 * `image_sources` rows, the MIME + width/height metadata the web renderer's
 * `<picture>` tag reads (see @hiroba/db schema/image-sources.ts).
 *
 * Every variant is best-effort and recorded, never assumed: GIFs are skipped
 * (Cloudflare Images won't produce animated AVIF, and resizing would eat the
 * animation), unknown formats are skipped, a size the raster already fits
 * inside is skipped, and any output that comes out no smaller than the
 * primary's bytes is discarded. Whatever survives is the group. Registration
 * is NOT ordered against the pointer that makes a render reachable (url row
 * / mirror state) — the web renders only recorded rows, so an unregistered
 * render just serves as a bare <img> until its rows land.
 */

import {
  deleteImageSourcesByGroup,
  replaceImageSourceGroup,
  type Database,
  type NewImageSource,
} from '@hiroba/db';
import { avifVariantKey, fitVariantKey, type FitSize } from '@hiroba/shared';

import { sniffMimeType } from './image-edit';

/** Source formats worth re-encoding. GIF is excluded: it's animated more
 *  often than not on the DQX CDN, and a still/resized re-encode would break
 *  the animation. */
const VARIANT_SOURCE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

/** One measured raster (nulls when Images can't decode it). */
type Measured = {
  mime: string | null;
  width: number | null;
  height: number | null;
};

async function measure(
  images: ImagesBinding,
  bytes: Uint8Array,
): Promise<Measured> {
  try {
    const info = await images.info(
      new Response(bytes).body as ReadableStream<Uint8Array>,
    );
    // SVG has a format but no pixel dimensions.
    if ('width' in info)
      return { mime: info.format, width: info.width, height: info.height };
    return { mime: info.format, width: null, height: null };
  } catch {
    return { mime: null, width: null, height: null };
  }
}

/**
 * Run one Images transform chain and keep the result only if it beat the
 * primary's size — the "no variant is better than a bigger variant" rule
 * every encode here shares. Null means "no variant", never an error.
 */
async function encodeVariant(
  images: ImagesBinding,
  bytes: Uint8Array,
  format: string,
  size?: FitSize,
): Promise<Uint8Array | null> {
  try {
    let input = images.input(
      new Response(bytes).body as ReadableStream<Uint8Array>,
    );
    // scale-down = fit inside the box, never enlarge.
    if (size) {
      input = input.transform({
        width: size.width,
        height: size.height,
        fit: 'scale-down',
      });
    }
    const result = await input.output({
      format: format as 'image/avif',
    });
    const out = new Uint8Array(await result.response().arrayBuffer());
    return out.byteLength < bytes.byteLength ? out : null;
  } catch (err) {
    console.error(
      `variant encode failed (${format}${size ? ` fit ${size.width}x${size.height}` : ''}):`,
      err,
    );
    return null;
  }
}

/**
 * Encode `bytes` to full-size AVIF via the Cloudflare Images binding. Returns
 * null when the source shouldn't or can't be encoded (GIF/unknown format,
 * transform failure, or the AVIF is no smaller) — "no variant", not an error.
 */
export async function encodeAvif(
  images: ImagesBinding,
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  const mime = sniffMimeType(bytes);
  if (!mime || !VARIANT_SOURCE_TYPES.has(mime)) return null;
  return encodeVariant(images, bytes, 'image/avif');
}

/**
 * Measure the object at `baseKey`, write its variants beside it (full-size
 * AVIF always attempted; fit-inside renditions in the source format + AVIF
 * for each entry of `opts.sizes`), and record the group's complete
 * `image_sources` row set. `opts.fallbackMime` covers bytes Images can't
 * decode (they still get a primary row — the group's existence is the
 * "attempted" marker).
 */
export async function registerImageSources(
  db: Database,
  images: ImagesBinding,
  bucket: R2Bucket,
  baseKey: string,
  bytes: Uint8Array,
  cacheControl: string,
  opts: { fallbackMime?: string; sizes?: FitSize[] } = {},
): Promise<void> {
  const measured = await measure(images, bytes);
  const sniffed = sniffMimeType(bytes);
  const mime =
    measured.mime ?? sniffed ?? opts.fallbackMime ?? 'application/octet-stream';
  const rows: Array<Omit<NewImageSource, 'createdAt'>> = [
    {
      key: baseKey,
      groupKey: baseKey,
      mime,
      width: measured.width,
      height: measured.height,
      bytes: bytes.byteLength,
    },
  ];

  /** Encode + store + record one variant; silently a no-op when skipped. */
  const addVariant = async (format: string, size?: FitSize): Promise<void> => {
    const out = await encodeVariant(images, bytes, format, size);
    if (!out) return;
    const key = size
      ? fitVariantKey(baseKey, size, format)
      : avifVariantKey(baseKey);
    await bucket.put(key, out, {
      httpMetadata: { contentType: format, cacheControl },
    });
    // Resized outputs are re-measured rather than computed: Cloudflare owns
    // the scale-down rounding, and the row's dimensions must match the bytes.
    const dims = size ? await measure(images, out) : measured;
    rows.push({
      key,
      groupKey: baseKey,
      mime: format,
      width: dims.width,
      height: dims.height,
      bytes: out.byteLength,
    });
  };

  // Variants only make sense for raster formats we can safely re-encode.
  if (sniffed && VARIANT_SOURCE_TYPES.has(sniffed)) {
    await addVariant('image/avif');
    for (const size of opts.sizes ?? []) {
      // A raster already inside the box has nothing to shrink — a "resized"
      // variant would just be a lossy re-encode at the same dimensions.
      const fits =
        measured.width !== null &&
        measured.height !== null &&
        measured.width <= size.width &&
        measured.height <= size.height;
      if (fits || measured.width === null) continue;
      await addVariant(sniffed, size);
      await addVariant('image/avif', size);
    }
  }

  // Replace the group's row set: a re-registration (self-heal, backfill
  // re-run, changed bytes at a fixed mirror key) whose encode outcomes
  // differ must retire the previous pass's rows — the web keeps emitting any
  // row it finds, and a stale <source> does not fall back on mismatch. Rows
  // fall out first, then their objects (deleteImageSourceGroup's contract);
  // the object delete is best-effort, an orphan is benign debris.
  const stale = await replaceImageSourceGroup(db, baseKey, rows);
  if (stale.length > 0) {
    try {
      await bucket.delete(stale);
    } catch (err) {
      console.warn(`stale variant delete failed for ${baseKey}:`, err);
    }
  }
}

/**
 * Delete one render's recorded variants AND their R2 objects — the one
 * blessed path for removing image_sources rows, so the table stays an exact
 * inventory of the bucket. Rows go first (readers stop emitting the URLs
 * immediately), then the objects in one bulk delete; a crash in between
 * leaves orphaned objects — the same benign, prunable debris a regeneration
 * leaves — never rows pointing at nothing. Returns how many objects were
 * removed. Callers make the group unreachable (url row / images row) before
 * calling.
 */
export async function deleteImageSourceGroup(
  db: Database,
  bucket: R2Bucket,
  groupKey: string,
): Promise<number> {
  const keys = await deleteImageSourcesByGroup(db, groupKey);
  if (keys.length > 0) await bucket.delete(keys);
  return keys.length;
}
