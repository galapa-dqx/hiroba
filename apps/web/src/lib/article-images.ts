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
 *    to reserve layout space (no CLS). An image with no render yet (not mirrored)
 *    falls back to the rewritten source URL, no dimensions.
 */

import {
  getImageSourcesByKeys,
  getImageTranslations,
  getServedImages,
  type Database,
} from '@hiroba/db';
import {
  collectImages,
  imageKey,
  rewriteImageSrc,
  type Block,
  type ResolvedImageSrc,
} from '@hiroba/richtext';

export async function hydrateArticleImages(
  db: Database,
  blocks: Block[],
  options: { isTranslated: boolean; language: string; imageBase?: string },
): Promise<(src: string) => string | ResolvedImageSrc> {
  const { isTranslated, language } = options;
  const originalBase = options.imageBase ?? '/img';

  const imgs = collectImages(blocks);
  const imgKeys = [
    ...new Set(
      imgs.map((i) => imageKey(i.src)).filter((k): k is string => !!k),
    ),
  ];

  // Original source key → the served render's primary file (key + dimensions).
  const servedByKey = new Map<string, ResolvedImageSrc>();
  if (imgKeys.length > 0) {
    const rows = await getImageSourcesByKeys(db, imgKeys);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const ids = rows.map((r) => r.id);
    const localizedText = isTranslated
      ? await getImageTranslations(db, ids, language)
      : new Map<number, string>();
    const served = await getServedImages(db, ids, language);

    for (const row of rows) {
      // Translated pages prefer the localized render, else the original; an
      // untranslated (JA) page always shows the original.
      const renders = served.get(row.id);
      const file = isTranslated
        ? (renders?.localized ?? renders?.original)
        : renders?.original;
      if (file) {
        servedByKey.set(row.key, {
          src: `${originalBase}/${file.key}`,
          width: file.width,
          height: file.height,
        });
      }
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
