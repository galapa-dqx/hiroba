/**
 * Article image hydration — the display-time half of the image pipeline,
 * shared by the news and topic detail pages. (News bodies currently carry no
 * images, so everything here no-ops for them — but the pages stay identical.)
 *
 * Two jobs:
 * 1. Hydrate each image's transient `text` with the displayed language's spans,
 *    so renderBlocks can put it on the image as alt (image text lives in the
 *    images / translations tables, not the block tree). A translated page
 *    prefers the translated spans and falls back to the JA transcription.
 * 2. Build the imageSrc rewriter: serve localized images from the VERSIONED
 *    key stored on the image's `url` translation row (`l10n/<lang>/v<ts>/…` —
 *    a fresh immutable object per render, so the URL changes exactly when the
 *    raster does), but only for images we actually localized; everything else
 *    (icons, text-free art, images not yet localized) keeps the original URL.
 *    Both variants are served straight from the R2 bucket's public host
 *    (IMAGE_BASE); the stored key always names a written object, so no
 *    fallback probe is needed.
 */

import {
  getImagesByKeys,
  getImageTranslations,
  type Database,
} from '@hiroba/db';
import {
  collectImages,
  imageKey,
  rewriteImageSrc,
  type Block,
} from '@hiroba/richtext';

export async function hydrateArticleImages(
  db: Database,
  blocks: Block[],
  options: { isTranslated: boolean; language: string; imageBase?: string },
): Promise<(src: string) => string> {
  const { isTranslated, language } = options;
  const originalBase = options.imageBase ?? '/img';

  const imgs = collectImages(blocks);
  const imgKeys = [
    ...new Set(
      imgs.map((i) => imageKey(i.src)).filter((k): k is string => !!k),
    ),
  ];

  // Original key → stored localized (versioned) R2 key, where one exists.
  const localizedByKey = new Map<string, string>();
  if (imgKeys.length > 0) {
    const rows = await getImagesByKeys(db, imgKeys);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const ids = rows.map((r) => r.id);
    const localizedText = isTranslated
      ? await getImageTranslations(db, ids, language, 'text')
      : new Map<number, string>();
    const localizedUrl = isTranslated
      ? await getImageTranslations(db, ids, language, 'url')
      : new Map<number, string>();
    for (const row of rows) {
      const stored = localizedUrl.get(row.id);
      if (stored) localizedByKey.set(row.key, stored);
    }
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

  return (src: string): string => {
    const key = imageKey(src);
    const stored = key ? localizedByKey.get(key) : undefined;
    if (stored) return `${originalBase}/${stored}`;
    return rewriteImageSrc(src, originalBase);
  };
}
