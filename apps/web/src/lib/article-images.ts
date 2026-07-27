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
  type ServedFile,
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
 * How wide an article-body image actually renders: the page column
 * (`--page-max` 860px less `main`'s 1.1rem inline padding), or the viewport
 * less that padding below the cap. Without this the browser assumes a
 * `w`-descriptor srcset fills the viewport and always takes the largest rung,
 * which is the whole saving thrown away.
 */
export const CONTENT_COLUMN_SIZES =
  '(min-width: 860px) 825px, calc(100vw - 2.2rem)';

/** Encoding preference for `<picture>` sources, smallest-typical-bytes first. */
const MIME_PREFERENCE = ['image/avif', 'image/webp'];
const mimeRank = (mime: string): number => {
  const i = MIME_PREFERENCE.indexOf(mime);
  return i === -1 ? MIME_PREFERENCE.length : i;
};

/**
 * The `w`-descriptor candidate list for one format, narrowest first, or null
 * when that format can't stand in for the primary.
 *
 * A format is only offered if it reaches the primary's FULL width: a browser
 * that picks a `<source>` is committed to it, so a ladder topping out below
 * full size would upscale on a wide viewport — worse than the fallback it
 * replaced. Files with unmeasured dimensions (migration seeds awaiting the
 * backfill) can't be placed on the ladder at all and are skipped.
 */
function candidates(
  files: ServedFile[],
  fullWidth: number,
  imageBase: string,
): string | null {
  const byWidth = new Map<number, string>();
  for (const f of files) {
    if (f.width === null || byWidth.has(f.width)) continue;
    byWidth.set(f.width, `${imageBase}/${f.key} ${f.width}w`);
  }
  if (!byWidth.has(fullWidth)) return null;
  return [...byWidth.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, candidate]) => candidate)
    .join(', ');
}

/**
 * Turn one served render into what the renderer wants: the primary's URL and
 * intrinsic dimensions, the downscaled rungs of its own format as a srcset,
 * and every alternate encoding that also spans the full ladder as a
 * `<picture>` source. `sizes` tells the browser how wide the image will
 * actually render — required for any of the rungs below full size to ever be
 * chosen.
 *
 * A render whose primary was never measured gets none of this: without a full
 * width there is no ladder to anchor, so it serves as a bare `<img>`.
 */
export function resolveRender(
  render: ServedRender,
  imageBase: string,
  sizes: string = CONTENT_COLUMN_SIZES,
): ResolvedImageSrc {
  const { primary } = render;
  const src = `${imageBase}/${primary.key}`;
  const base = { src, width: primary.width, height: primary.height };
  if (primary.width === null || primary.mime === null) return base;

  // Group every recorded file by format; the primary's own group becomes the
  // <img>'s srcset, the rest become <source>s.
  const byMime = new Map<string, ServedFile[]>();
  for (const f of [primary, ...render.derived]) {
    if (f.mime === null) continue;
    byMime.set(f.mime, [...(byMime.get(f.mime) ?? []), f]);
  }

  const own = candidates(
    byMime.get(primary.mime) ?? [],
    primary.width,
    imageBase,
  );
  const sources = [...byMime.entries()]
    .filter(([mime]) => mime !== primary.mime)
    // The browser takes the first <source> it supports, so order is the whole
    // point — best encoding first, unknown ones last.
    .sort(([a], [b]) => mimeRank(a) - mimeRank(b))
    .flatMap(([mime, files]) => {
      const srcset = candidates(files, primary.width as number, imageBase);
      return srcset ? [{ type: mime, srcset }] : [];
    });

  // A lone full-size candidate is just `src` again — emit the srcset only when
  // there is an actual choice to make.
  const hasRungs = (own?.includes(',') ?? false) || sources.length > 0;
  return {
    ...base,
    ...(own && own.includes(',') ? { srcset: own } : {}),
    ...(sources.length ? { sources } : {}),
    ...(hasRungs ? { sizes } : {}),
  };
}

export async function hydrateArticleImages(
  db: Database,
  blocks: Block[],
  options: {
    isTranslated: boolean;
    language: string;
    imageBase?: string;
    /** CSS `sizes` for the images in this body; defaults to the page column,
     *  which is what every article surface renders into today. */
    sizes?: string;
  },
): Promise<(src: string) => string | ResolvedImageSrc> {
  const { isTranslated, language } = options;
  const originalBase = options.imageBase ?? '/img';
  const sizes = options.sizes ?? CONTENT_COLUMN_SIZES;

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
      if (render)
        servedByKey.set(row.key, resolveRender(render, originalBase, sizes));
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
