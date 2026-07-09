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
 * 2. Build the imageSrc rewriter: serve localized images from the
 *    l10n/<lang>/<key> object, but only for images we actually localized;
 *    everything else (icons, text-free art, images not yet localized) keeps the
 *    original URL — so a browser never caches the original under an l10n URL
 *    and then keeps serving it after the localized version lands. Both variants
 *    are served straight from the R2 bucket's public host (IMAGE_BASE); the
 *    localize-images step never wrote an l10n object for an unlocalized image,
 *    so an l10n URL here is always known to exist and needs no fallback probe.
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

  // Keys whose localized (l10n/<lang>) image actually exists.
  const localizedKeys = new Set<string>();
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
    for (const row of rows)
      if (localizedUrl.has(row.id)) localizedKeys.add(row.key);
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
    const base =
      isTranslated && key && localizedKeys.has(key)
        ? `${originalBase}/l10n/${language}`
        : originalBase;
    return rewriteImageSrc(src, base);
  };
}
