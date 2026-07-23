/**
 * Image queries for the admin Images screens — admin-only, so they live here
 * rather than in the shared db package (DQX-54). The render/serving primitives
 * every consumer shares (getServedImages, insertImageRender, renderIsNewer…)
 * stay in @hiroba/db.
 */

import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  lt,
  sql,
} from 'drizzle-orm';
import { type Temporal } from 'temporal-polyfill';

import {
  articleTable,
  banners,
  chunked,
  imageFiles,
  images,
  imageSources,
  renderIsNewer,
  syncArticleImages,
  translations,
  type ArticleType,
  type Database,
  type ImageSource,
  type Translation,
} from '@hiroba/db';

/** The newest localized render for a source in one language — its primary file
 *  key, producing model, and timestamp (the admin panels' localized-image
 *  state, now that there's no `url` translation row). */
export type LatestRender = {
  key: string;
  model: string | null;
  createdAt: Temporal.Instant;
};

/**
 * Newest localized render per source for one language (primary file key + model
 * + created_at) — the admin Images list's localized-image column.
 */
async function getLatestLocalizedRenders(
  db: Database,
  sourceIds: number[],
  language: string,
): Promise<Map<number, LatestRender>> {
  const result = new Map<number, LatestRender>();
  if (sourceIds.length === 0) return result;

  const rows = await chunked(sourceIds, (slice) =>
    db
      .select({
        sourceId: images.sourceId,
        model: images.model,
        createdAt: images.createdAt,
        id: images.id,
        key: imageFiles.key,
      })
      .from(images)
      .innerJoin(
        imageFiles,
        and(eq(imageFiles.imageId, images.id), eq(imageFiles.isPrimary, true)),
      )
      .where(
        and(inArray(images.sourceId, slice), eq(images.language, language)),
      )
      .all(),
  );

  const best = new Map<number, { createdAt: Temporal.Instant; id: string }>();
  for (const r of rows) {
    const prev = best.get(r.sourceId);
    if (!prev || renderIsNewer(r, prev)) {
      best.set(r.sourceId, r);
      result.set(r.sourceId, {
        key: r.key,
        model: r.model,
        createdAt: r.createdAt,
      });
    }
  }
  return result;
}

/**
 * Newest localized render per language for ONE source (primary file key + model
 * + created_at) — the admin image-edit screen's per-language state.
 */
export async function getLatestRendersBySource(
  db: Database,
  sourceId: number,
): Promise<Map<string, LatestRender>> {
  const rows = await db
    .select({
      language: images.language,
      model: images.model,
      createdAt: images.createdAt,
      id: images.id,
      key: imageFiles.key,
    })
    .from(images)
    .innerJoin(
      imageFiles,
      and(eq(imageFiles.imageId, images.id), eq(imageFiles.isPrimary, true)),
    )
    .where(and(eq(images.sourceId, sourceId), isNotNull(images.language)))
    .all();

  const result = new Map<string, LatestRender>();
  const best = new Map<string, { createdAt: Temporal.Instant; id: string }>();
  for (const r of rows) {
    const lang = r.language!;
    const prev = best.get(lang);
    if (!prev || renderIsNewer(r, prev)) {
      best.set(lang, r);
      result.set(lang, { key: r.key, model: r.model, createdAt: r.createdAt });
    }
  }
  return result;
}

/**
 * One image source plus its per-language state — the shape behind the admin
 * Images screen. `text` is the translated-spans row (null until that step runs);
 * `localized` is the newest localized render for the language (null until one
 * exists — its presence IS the "localized" signal, there's no `url` row now).
 */
export type AdminImageRow = {
  image: ImageSource;
  text: Translation | null;
  localized: LatestRender | null;
  /** True when this image backs a rotation banner (banners.imageKey = key). */
  isBanner: boolean;
};

/** Image source categories the admin screen can filter to (banner is the only
 * one with a first-class join today; topic/playguide live in block trees). */
export type ImageSourceFilter = 'banner';

/**
 * A GLOB that matches any hiragana/katakana/kanji character — the SQL twin of
 * `hasJapanese` (see @hiroba/shared). Because a `texts_ja` value is a JSON array
 * whose structural characters (`[] "",`) are all ASCII, matching Japanese
 * anywhere in the raw text is exactly "some span contains Japanese".
 */
const JAPANESE_GLOB = '*[぀-ヿ㐀-䶿一-鿿ｦ-ﾟ]*';

/**
 * List image sources newest-first (by surrogate id), each paired with its
 * translated-spans row and newest localized render for one language.
 * Cursor-paginated on the id so the admin can lazily page the whole corpus.
 *
 * `onlyText` and `source` filter server-side (in the WHERE clause), so paging
 * and the has-more/next-cursor accounting are computed over the filtered set —
 * "Load more" walks the matches, not every image.
 */
export async function listImagesForAdmin(
  db: Database,
  opts: {
    language: string;
    limit?: number;
    cursor?: number;
    /** Keep only images bearing Japanese text (localization candidates). */
    onlyText?: boolean;
    /** Keep only images from this source (currently: rotation banners). */
    source?: ImageSourceFilter;
  },
): Promise<{ rows: AdminImageRow[]; hasMore: boolean; nextCursor?: number }> {
  const limit = Math.min(opts.limit ?? 30, 100);
  // Every page is the same `id < cursor` shape; the first page uses a sentinel
  // above every id (ids are autoincrement, so MAX_SAFE_INTEGER matches all).
  const cursor = opts.cursor ?? Number.MAX_SAFE_INTEGER;

  const conditions = [lt(imageSources.id, cursor)];
  if (opts.onlyText) {
    // Transcribed (non-null) and carrying at least one Japanese character.
    conditions.push(isNotNull(imageSources.textsJa));
    conditions.push(sql`${imageSources.textsJa} GLOB ${JAPANESE_GLOB}`);
  }
  if (opts.source === 'banner') {
    conditions.push(
      exists(
        db
          .select({ one: sql`1` })
          .from(banners)
          .where(eq(banners.imageKey, imageSources.key)),
      ),
    );
  }

  const imgRows = await db
    .select()
    .from(imageSources)
    .where(and(...conditions))
    .orderBy(desc(imageSources.id))
    .limit(limit + 1)
    .all();

  const hasMore = imgRows.length > limit;
  const page = hasMore ? imgRows.slice(0, limit) : imgRows;

  // This language's translated-spans rows + newest localized render per source.
  const ids = page.map((r) => r.id);
  const trRows = ids.length
    ? await chunked(ids.map(String), (slice) =>
        db
          .select()
          .from(translations)
          .where(
            and(
              eq(translations.itemType, 'image'),
              eq(translations.language, opts.language),
              eq(translations.field, 'text'),
              inArray(translations.itemId, slice),
            ),
          )
          .all(),
      )
    : [];
  const textById = new Map<number, Translation>();
  for (const tr of trRows) textById.set(Number(tr.itemId), tr);

  const localizedById = await getLatestLocalizedRenders(db, ids, opts.language);

  // Which of this page's images back a rotation banner (banners.imageKey = key).
  // Banners are the one image source with a first-class join, so we can tag them
  // cheaply here; topic/playguide membership lives only inside block trees. When
  // the page is already filtered to banners, every row is one — skip the query.
  const keys = page.map((r) => r.key);
  const bannerKeys =
    opts.source === 'banner' || keys.length === 0
      ? new Set(keys)
      : new Set(
          (
            await chunked(keys, (slice) =>
              db
                .select({ imageKey: banners.imageKey })
                .from(banners)
                .where(inArray(banners.imageKey, slice))
                .all(),
            )
          ).map((r) => r.imageKey),
        );

  const rows = page.map((image) => ({
    image,
    text: textById.get(image.id) ?? null,
    localized: localizedById.get(image.id) ?? null,
    isBanner: bannerKeys.has(image.key),
  }));

  return {
    rows,
    hasMore,
    nextCursor: hasMore ? page[page.length - 1].id : undefined,
  };
}

/**
 * Backfill one page of the article_images index for one item type — for
 * articles written before the index existed (new writes keep it current via
 * syncArticleImages). Cursor-paginated by id; idempotent, so re-running over
 * already-indexed articles is harmless.
 */
export async function backfillArticleImages(
  db: Database,
  itemType: ArticleType,
  cursor: string | null,
  limit = 100,
): Promise<{ processed: number; nextCursor: string | null }> {
  const table = articleTable(itemType);
  const rows = await db
    .select({ id: table.id, blocksJa: table.blocksJa })
    .from(table)
    .where(cursor ? gt(table.id, cursor) : undefined)
    .orderBy(asc(table.id))
    .limit(limit)
    .all();
  for (const row of rows) {
    if (row.blocksJa) {
      await syncArticleImages(db, itemType, row.id, row.blocksJa);
    }
  }
  return {
    processed: rows.length,
    nextCursor: rows.length === limit ? rows[rows.length - 1].id : null,
  };
}
