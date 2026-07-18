/**
 * Measure a stored raster via the Cloudflare Images binding — the width/height/
 * mime the `image_files` primary row records at write time (DQX-45), and the
 * baseline DQX-49's encode-skip + `<source>` rules build on. Best-effort: bytes
 * Images can't decode measure to NULL dims (the row still lands; its existence
 * is the "render written" signal).
 */

import type { RenderFileInput } from '@hiroba/db';

export type Measured = {
  mime: string | null;
  width: number | null;
  height: number | null;
};

/** Measure `bytes` (mime + pixel dimensions) via the Images binding. */
export async function measureImage(
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
 * Build the primary `image_files` input for a render's byte-exact raster,
 * measuring its dimensions. `fallbackMime` (the stored content type) covers
 * bytes the Images binding can't decode.
 */
export async function measurePrimaryFile(
  images: ImagesBinding,
  key: string,
  bytes: Uint8Array,
  fallbackMime: string | null,
): Promise<RenderFileInput> {
  const m = await measureImage(images, bytes);
  return {
    key,
    isPrimary: true,
    mime: m.mime ?? fallbackMime,
    width: m.width,
    height: m.height,
    bytes: bytes.byteLength,
  };
}
