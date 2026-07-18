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
  getImageSourcesByKeys,
  getServedImages,
  getTitleTranslations,
  type Database,
} from '@hiroba/db';
import { imageUpstreamUrl, rewriteImageSrc } from '@hiroba/richtext';

export type CarouselBanner = {
  imageUrl: string;
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

  // Original key → the localized render's primary file key for this language.
  const imgRows = await getImageSourcesByKeys(
    db,
    rows.map((r) => r.imageKey),
  );
  const served = await getServedImages(
    db,
    imgRows.map((r) => r.id),
    language,
  );
  const localizedByKey = new Map<string, string>();
  for (const r of imgRows) {
    const stored = served.get(r.id)?.localized?.key;
    if (stored) localizedByKey.set(r.key, stored);
  }

  // Translated captions for banners that link to a topic we can render.
  const topicIds = rows
    .map((r) => r.linkTopicId)
    .filter((id): id is string => !!id);
  const titles = await getTitleTranslations(db, 'topic', topicIds, language);

  return rows.map((b) => {
    const stored = localizedByKey.get(b.imageKey);
    return {
      imageUrl: stored
        ? `${imageBase}/${stored}`
        : rewriteImageSrc(imageUpstreamUrl(b.imageKey), imageBase),
      href: b.linkTopicId
        ? `/${language}/topics/${b.linkTopicId}`
        : (b.linkUrl ?? '#'),
      external: !b.linkTopicId && !!b.linkUrl,
      alt: (b.linkTopicId ? titles.get(b.linkTopicId) : undefined) ?? b.altJa,
    };
  });
}
