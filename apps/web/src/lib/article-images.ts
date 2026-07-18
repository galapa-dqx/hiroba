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
  getImageSourcesByGroups,
  getImageTranslations,
  type Database,
  type ImageSource,
} from '@hiroba/db';
import {
  collectImages,
  collectImageUrls,
  imageKey,
  rewriteImageSrc,
  type Block,
  type ResolvedImage,
} from '@hiroba/richtext';

export async function hydrateArticleImages(
  db: Database,
  blocks: Block[],
  options: { isTranslated: boolean; language: string; imageBase?: string },
): Promise<(src: string) => ResolvedImage> {
  const { isTranslated, language } = options;
  const originalBase = options.imageBase ?? '/img';

  const imgs = collectImages(blocks);
  const imgKeys = [
    ...new Set(
      imgs.map((i) => imageKey(i.src)).filter((k): k is string => !!k),
    ),
  ];
  // EVERY mirrorable key the renderer will resolve — block images plus the
  // inline icons and speech-bubble portraits collectImages doesn't walk. The
  // text/localization hydration above only concerns block images (imgKeys),
  // but variant rows exist for all of them.
  const allKeys = [
    ...new Set(
      collectImageUrls(blocks)
        .map((src) => imageKey(src))
        .filter((k): k is string => !!k),
    ),
  ];

  // Original key → stored localized (versioned) R2 key, where one exists.
  // Whichever key a src resolves to is also its image_sources group key, so
  // one fetch over the union covers dimensions + alternate encodings for
  // localized and original rasters alike. Variants are only ever emitted from
  // recorded rows (never derived): a <picture> source that 404s would NOT
  // fall back to the <img>.
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
  const sourcesByGroup =
    allKeys.length > 0
      ? await getImageSourcesByGroups(db, [
          ...new Set([...allKeys, ...localizedByKey.values()]),
        ])
      : new Map<string, ImageSource[]>();

  return (src: string): ResolvedImage => {
    const key = imageKey(src);
    const stored = key ? localizedByKey.get(key) : undefined;
    const groupKey = stored ?? key;
    const url = stored
      ? `${originalBase}/${stored}`
      : rewriteImageSrc(src, originalBase);
    return resolveFromSources(
      url,
      groupKey ? sourcesByGroup.get(groupKey) : undefined,
      originalBase,
    );
  };
}

/**
 * Build a renderer-ready image from a group's recorded variant rows (query
 * returns them primary-first, alternates most-preferred first). No rows —
 * a render predating the image_sources backfill — means just the src.
 *
 * Only FULL-SIZE encoding alternates (same dimensions as the primary,
 * different format) become `<picture>` sources: a `<source>` without srcset
 * descriptors is a 1x candidate, so emitting a resized rendition here would
 * serve a shrunken raster at full display size. Resized renditions stay
 * recorded-but-unemitted until a consumer with real `sizes` knowledge
 * (thumbnails, srcset) reads them.
 */
export function resolveFromSources(
  src: string,
  group: ImageSource[] | undefined,
  imageBase: string,
): ResolvedImage {
  const primary = group?.find((r) => r.key === r.groupKey);
  const alternates =
    group?.filter(
      (r) =>
        r.key !== r.groupKey &&
        r.mime !== primary?.mime &&
        r.width === primary?.width &&
        r.height === primary?.height,
    ) ?? [];
  return {
    src,
    ...(primary?.width && primary?.height
      ? { width: primary.width, height: primary.height }
      : {}),
    ...(alternates.length
      ? {
          sources: alternates.map((r) => ({
            src: `${imageBase}/${r.key}`,
            type: r.mime,
          })),
        }
      : {}),
  };
}
