/**
 * Measure a raster via the Cloudflare Images binding — the write-side
 * companion of `image_files`: every writer that records a render measures its
 * primary file's mime + pixel dimensions with this before inserting the row
 * (DQX-45), and DQX-49's encode-skip + `<source>` rules build on the same
 * numbers. Best-effort: bytes the binding can't decode measure to nulls (the
 * row still lands; its existence is the "render written" signal).
 *
 * Lives in @hiroba/db (not @hiroba/shared) because it needs the Workers
 * runtime types (ImagesBinding), which the platform-free packages that consume
 * shared don't have — every consumer of this package is a worker.
 */

export type Measured = {
  mime: string | null;
  width: number | null;
  height: number | null;
};

/** Measure `bytes` (mime + pixel dimensions) via the Images binding. */
export async function measureImage(
  images: ImagesBinding,
  bytes: Uint8Array | ArrayBuffer,
): Promise<Measured> {
  try {
    const info = await images.info(
      new Response(bytes as BodyInit).body as ReadableStream<Uint8Array>,
    );
    // SVG has a format but no pixel dimensions.
    if ('width' in info)
      return { mime: info.format, width: info.width, height: info.height };
    return { mime: info.format, width: null, height: null };
  } catch {
    return { mime: null, width: null, height: null };
  }
}
