/**
 * Home-page rotation banners — the display-time resolver for the carousel.
 *
 * Each banner's image is a row in the shared `images` table, so it resolves to a
 * URL exactly like article images (see article-images.ts): the versioned
 * localized object recorded on its `url` translation row when we actually
 * localized it, else the original —
 * both served from the R2 public host (IMAGE_BASE). A banner links to our
 * translated topic page when it points at a topic we render, otherwise to its
 * original external URL. The visible caption is baked into the (translated)
 * image; the `alt` is the linked topic's translated title when available, else
 * the source Japanese caption.
 */

import {
  getActiveBanners,
  getImagesByKeys,
  getImageSourcesByGroups,
  getImageTranslations,
  getTitleTranslations,
  type Database,
} from '@hiroba/db';
import { imageUpstreamUrl, rewriteImageSrc } from '@hiroba/richtext';

import { resolveFromSources } from './article-images';

export type CarouselBanner = {
  imageUrl: string;
  /** Recorded alternate encodings of the image (image_sources rows), most-
   *  preferred first — rendered as `<picture>` sources with `imageUrl` as
   *  the fallback. */
  sources?: Array<{ src: string; type: string }>;
  href: string;
  /** True when the link leaves our site (renderer adds target/rel). */
  external: boolean;
  alt: string;
};

export async function resolveBanners(
  db: Database,
  options: { language: string; imageBase: string },
): Promise<CarouselBanner[]> {
  const { language, imageBase } = options;

  const rows = await getActiveBanners(db);
  if (rows.length === 0) return [];

  // Original key → stored localized (versioned) R2 key for this language.
  const imgRows = await getImagesByKeys(
    db,
    rows.map((r) => r.imageKey),
  );
  const localizedUrl = await getImageTranslations(
    db,
    imgRows.map((r) => r.id),
    language,
    'url',
  );
  const localizedByKey = new Map<string, string>();
  for (const r of imgRows) {
    const stored = localizedUrl.get(r.id);
    if (stored) localizedByKey.set(r.key, stored);
  }
  // Whichever key each banner serves is also its image_sources group key —
  // one fetch covers the localized renders and the original fallbacks.
  const sourcesByGroup = await getImageSourcesByGroups(db, [
    ...new Set([...rows.map((b) => b.imageKey), ...localizedByKey.values()]),
  ]);

  // Translated captions for banners that link to a topic we can render.
  const topicIds = rows
    .map((r) => r.linkTopicId)
    .filter((id): id is string => !!id);
  const titles = await getTitleTranslations(db, 'topic', topicIds, language);

  return rows.map((b) => {
    const stored = localizedByKey.get(b.imageKey);
    const groupKey = stored ?? b.imageKey;
    const resolved = resolveFromSources(
      stored
        ? `${imageBase}/${stored}`
        : rewriteImageSrc(imageUpstreamUrl(b.imageKey), imageBase),
      sourcesByGroup.get(groupKey),
      imageBase,
    );
    return {
      imageUrl: resolved.src,
      ...(resolved.sources ? { sources: resolved.sources } : {}),
      href: b.linkTopicId
        ? `/${language}/topics/${b.linkTopicId}`
        : (b.linkUrl ?? '#'),
      external: !b.linkTopicId && !!b.linkUrl,
      alt: (b.linkTopicId ? titles.get(b.linkTopicId) : undefined) ?? b.altJa,
    };
  });
}
