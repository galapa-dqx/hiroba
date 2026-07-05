/**
 * Article image hydration — the display-time half of the image pipeline,
 * shared by the news and topic detail pages. (News bodies currently carry no
 * images, so everything here no-ops for them — but the pages stay identical.)
 *
 * Two jobs:
 * 1. Hydrate each image's transient `text` with the displayed language's spans,
 *    so renderBlocks can put it on the image as alt (image text lives in the
 *    images / translations tables, not the block tree). EN prefers the
 *    translated spans and falls back to the JA transcription.
 * 2. Build the imageSrc rewriter: serve English-localized images from the
 *    l10n/en/<key> object, but only for images we actually localized;
 *    everything else (icons, text-free art, images not yet localized) keeps the
 *    original URL — so a browser never caches the original under an l10n URL
 *    and then keeps serving it after the localized version lands. Originals may
 *    come from a bucket custom-domain via IMAGE_BASE; the /img route still
 *    falls back to the original for a stray l10n request, but we no longer emit
 *    one for an unlocalized image.
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
  options: { isTranslated: boolean; imageBase?: string },
): Promise<(src: string) => string> {
  const { isTranslated } = options;
  const originalBase = options.imageBase ?? '/img';

  const imgs = collectImages(blocks);
  const imgKeys = [
    ...new Set(
      imgs.map((i) => imageKey(i.src)).filter((k): k is string => !!k),
    ),
  ];

  // Keys whose localized (l10n/en) image actually exists.
  const localizedKeys = new Set<string>();
  if (imgKeys.length > 0) {
    const rows = await getImagesByKeys(db, imgKeys);
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const ids = rows.map((r) => r.id);
    const enText = isTranslated
      ? await getImageTranslations(db, ids, 'en', 'text')
      : new Map<number, string>();
    const enUrl = isTranslated
      ? await getImageTranslations(db, ids, 'en', 'url')
      : new Map<number, string>();
    for (const row of rows) if (enUrl.has(row.id)) localizedKeys.add(row.key);
    for (const img of imgs) {
      const key = imageKey(img.src);
      const row = key ? byKey.get(key) : undefined;
      const en = row && isTranslated ? enText.get(row.id) : undefined;
      const spans = en
        ? (JSON.parse(en) as string[])
        : (row?.textsJa ?? undefined);
      if (spans && spans.length) img.text = spans;
      else delete img.text;
    }
  }

  return (src: string): string => {
    const key = imageKey(src);
    const base =
      isTranslated && key && localizedKeys.has(key)
        ? '/img/l10n/en'
        : originalBase;
    return rewriteImageSrc(src, base);
  };
}
