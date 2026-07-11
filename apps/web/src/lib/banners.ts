/**
 * Home-page rotation banners — the display-time resolver for the carousel.
 *
 * Each banner's image is a row in the shared `images` table, so it resolves to a
 * URL exactly like article images (see article-images.ts): the localized
 * `l10n/<lang>/<key>` object when we actually localized it, else the original —
 * both served from the R2 public host (IMAGE_BASE). A banner links to our
 * translated topic page when it points at a topic we render, otherwise to its
 * original external URL. The visible caption is baked into the (translated)
 * image; the `alt` is the linked topic's translated title when available, else
 * the source Japanese caption.
 */

import {
  getActiveBanners,
  getImagesByKeys,
  getImageTranslations,
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

  // Which banner images have a localized variant for this language.
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
  const localizedKeys = new Set(
    imgRows.filter((r) => localizedUrl.has(r.id)).map((r) => r.key),
  );

  // Translated captions for banners that link to a topic we can render.
  const topicIds = rows
    .map((r) => r.linkTopicId)
    .filter((id): id is string => !!id);
  const titles = await getTitleTranslations(db, 'topic', topicIds, language);

  return rows.map((b) => {
    const base = localizedKeys.has(b.imageKey)
      ? `${imageBase}/l10n/${language}`
      : imageBase;
    return {
      imageUrl: rewriteImageSrc(imageUpstreamUrl(b.imageKey), base),
      href: b.linkTopicId
        ? `/${language}/topics/${b.linkTopicId}`
        : (b.linkUrl ?? '#'),
      external: !b.linkTopicId && !!b.linkUrl,
      alt: (b.linkTopicId ? titles.get(b.linkTopicId) : undefined) ?? b.altJa,
    };
  });
}
