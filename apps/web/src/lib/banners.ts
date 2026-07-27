/**
 * Home-page rotation banners — the display-time resolver for the carousel.
 *
 * Each banner's image is a source in the shared `image_sources` table, so it
 * resolves exactly like an article image (see article-images.ts): the newest
 * localized render when we have one, else the mirrored original — both served
 * from the R2 public host (IMAGE_BASE), with the render's measured dimensions
 * and alternate encodings. A banner links to our
 * translated topic page when it points at a topic we render, otherwise to its
 * original external URL. The visible caption is baked into the (translated)
 * image; the `alt` is the linked topic's translated title when available, else
 * the source Japanese caption.
 */

import {
  getImageSourcesByKeys,
  getServedImages,
  getTitleTranslations,
  type Database,
} from '@hiroba/db';
import {
  imageUpstreamUrl,
  rewriteImageSrc,
  type ResolvedImageSrc,
} from '@hiroba/richtext';

import { resolveRender } from './article-images';

/**
 * The carousel slot: the page column, less the gilt frame's 7px padding on
 * each side. Same shape as the article column (see CONTENT_COLUMN_SIZES) —
 * `sizes` is a hint, so being a few px generous costs nothing.
 */
const BANNER_SIZES = '(min-width: 860px) 811px, calc(100vw - 2.2rem - 14px)';

export type CarouselBanner = {
  imageUrl: string;
  /** The raster's measured intrinsic dimensions; the carousel falls back to
   *  the nominal slot size when the render predates measurement. */
  width?: number;
  height?: number;
  /** Downscaled candidates for `imageUrl`'s own format (DQX-49), `w`-descriptor
   *  form, paired with `sizes`. */
  srcset?: string;
  /** How wide the slide actually renders — meaningless without a srcset. */
  sizes?: string;
  /** Alternate encodings of the same raster, most-preferred first — rendered
   *  as `<picture>` sources with `imageUrl` as the fallback. */
  sources?: Array<{ type: string; srcset: string }>;
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

  const rows = await db.query.banners.findMany({
    where: { active: true },
    orderBy: { sortOrder: 'asc' },
  });
  if (rows.length === 0) return [];

  // Original key → the render that serves it in this language: the localized
  // one where we have it, else the mirrored original (same URL the upstream
  // rewrite would produce, but carrying dimensions and alternate encodings).
  const imgRows = await getImageSourcesByKeys(
    db,
    rows.map((r) => r.imageKey),
  );
  const served = await getServedImages(
    db,
    imgRows.map((r) => r.id),
    language,
  );
  const resolvedByKey = new Map<string, ResolvedImageSrc>();
  for (const r of imgRows) {
    const renders = served.get(r.id);
    const render = renders?.localized ?? renders?.original;
    if (render)
      resolvedByKey.set(r.key, resolveRender(render, imageBase, BANNER_SIZES));
  }

  // Translated captions for banners that link to a topic we can render.
  const topicIds = rows
    .map((r) => r.linkTopicId)
    .filter((id): id is string => !!id);
  const titles = await getTitleTranslations(db, 'topic', topicIds, language);

  return rows.map((b) => {
    const resolved = resolvedByKey.get(b.imageKey);
    return {
      imageUrl:
        resolved?.src ??
        rewriteImageSrc(imageUpstreamUrl(b.imageKey), imageBase),
      ...(resolved?.width != null ? { width: resolved.width } : {}),
      ...(resolved?.height != null ? { height: resolved.height } : {}),
      ...(resolved?.srcset ? { srcset: resolved.srcset } : {}),
      ...(resolved?.sizes ? { sizes: resolved.sizes } : {}),
      ...(resolved?.sources ? { sources: resolved.sources } : {}),
      href: b.linkTopicId
        ? `/${language}/topics/${b.linkTopicId}`
        : (b.linkUrl ?? '#'),
      external: !b.linkTopicId && !!b.linkUrl,
      alt: (b.linkTopicId ? titles.get(b.linkTopicId) : undefined) ?? b.altJa,
    };
  });
}
