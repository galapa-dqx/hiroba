/**
 * Article image hydration — the display-time half of the image pipeline,
 * shared by the news and topic detail pages. (News bodies currently carry no
 * images, so everything here no-ops for them — but the pages stay identical.)
 *
 * Two jobs:
 * 1. Hydrate each image's transient `text` with the displayed language's spans,
 *    so renderBlocks can put it on the image as alt (image text lives in the
 *    image_sources / translations tables, not the block tree). A translated page
 *    prefers the translated spans and falls back to the JA transcription.
 * 2. Build the imageSrc resolver: serve each image from its newest render (a
 *    first-class row since DQX-45). On a translated page the localized render
 *    wins (its versioned `l10n/…` key — a fresh immutable object per render);
 *    otherwise the mirrored original's render (its primary file sits at the
 *    source key). Both come with measured width/height, which the renderer emits
 *    to reserve layout space (no CLS), and with the render's alternate encodings
 *    (DQX-49) for the `<picture>` wrapper. An image with no render yet (not
 *    mirrored) falls back to the rewritten source URL, bare.
 */

import {
  getImageSourcesByKeys,
  getImageTranslations,
  getServedImages,
  type Database,
  type ServedRender,
} from '@hiroba/db';
import {
  collectImages,
  collectImageUrls,
  imageKey,
  rewriteImageSrc,
  type Block,
  type ResolvedImageSrc,
} from '@hiroba/richtext';

/**
 * Turn one served render into what the renderer wants: the primary's URL and
 * intrinsic dimensions, plus the derived files that may stand in for it.
 *
 * Only FULL-SIZE encoding alternates become `<picture>` sources — same pixel
 * dimensions as the primary, different MIME. A `<source>` without srcset
 * descriptors is a 1x candidate, so offering a fit rendition here would serve
 * a shrunken raster at full display size; renditions stay recorded-but-
 * unemitted until a consumer with real `sizes` knowledge reads them (DQX-48).
 * Files with unmeasured dimensions (migration seeds awaiting the backfill) are
 * never offered: "same dimensions" can't be established.
 */
export function resolveRender(
  render: ServedRender,
  imageBase: string,
): ResolvedImageSrc {
  const { primary } = render;
  const alternates = render.derived
    .flatMap((f) =>
      f.mime !== null &&
      f.mime !== primary.mime &&
      f.width !== null &&
      f.width === primary.width &&
      f.height === primary.height
        ? [{ src: `${imageBase}/${f.key}`, type: f.mime }]
        : [],
    )
    // The browser takes the first <source> it supports, so order is the whole
    // point — best encoding first, unknown ones last.
    .sort((a, b) => mimeRank(a.type) - mimeRank(b.type));
  return {
    src: `${imageBase}/${primary.key}`,
    width: primary.width,
    height: primary.height,
    ...(alternates.length ? { sources: alternates } : {}),
  };
}

/** Encoding preference for `<picture>` sources, smallest-typical-bytes first. */
const MIME_PREFERENCE = ['image/avif', 'image/webp'];
const mimeRank = (mime: string): number => {
  const i = MIME_PREFERENCE.indexOf(mime);
  return i === -1 ? MIME_PREFERENCE.length : i;
};

export async function hydrateArticleImages(
  db: Database,
  blocks: Block[],
  options: { isTranslated: boolean; language: string; imageBase?: string },
): Promise<(src: string) => string | ResolvedImageSrc> {
  const { isTranslated, language } = options;
  const originalBase = options.imageBase ?? '/img';

  const imgs = collectImages(blocks);
  const imgKeys = new Set(
    imgs.map((i) => imageKey(i.src)).filter((k): k is string => !!k),
  );
  // EVERY mirrorable key the renderer will resolve — the block images above
  // plus the inline icons and speech portraits collectImages doesn't walk.
  // Only block images carry hydratable text, but all of them have renders
  // worth serving (dimensions, alternate encodings).
  const allKeys = [
    ...new Set(
      collectImageUrls(blocks)
        .map((src) => imageKey(src))
        .filter((k): k is string => !!k),
    ),
  ];

  // Original source key → the served render, resolved for the renderer.
  const servedByKey = new Map<string, ResolvedImageSrc>();
  if (allKeys.length > 0) {
    const rows = await getImageSourcesByKeys(db, allKeys);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const ids = rows.map((r) => r.id);
    const textIds = rows.filter((r) => imgKeys.has(r.key)).map((r) => r.id);
    const localizedText = isTranslated
      ? await getImageTranslations(db, textIds, language)
      : new Map<number, string>();
    const served = await getServedImages(db, ids, language);

    for (const row of rows) {
      // Translated pages prefer the localized render, else the original; an
      // untranslated (JA) page always shows the original.
      const renders = served.get(row.id);
      const render = isTranslated
        ? (renders?.localized ?? renders?.original)
        : renders?.original;
      if (render) servedByKey.set(row.key, resolveRender(render, originalBase));
    }

    // Alt text: translated spans when available, else the JA transcription.
    for (const img of imgs) {
      const key = imageKey(img.src);
      const row = key ? byKey.get(key) : undefined;
      const translated =
        row && isTranslated ? localizedText.get(row.id) : undefined;
      const spans = translated
        ? (JSON.parse(translated) as string[])
        : (row?.textsJa ?? undefined);
      if (spans && spans.length) img.text = spans;
      else delete img.text;
    }
  }

  return (src: string): string | ResolvedImageSrc => {
    const key = imageKey(src);
    const served = key ? servedByKey.get(key) : undefined;
    if (served) return served;
    return rewriteImageSrc(src, originalBase);
  };
}
