/**
 * article_images — which articles embed which mirrored images, maintained from
 * the block tree on every `blocks_ja` write (see syncArticleImages). This is
 * the reverse index the cache story needs: localized images live at versioned
 * immutable URLs, so when an admin regenerates or uploads one, the pages
 * embedding it must be purged for the new URL to reach readers — and "which
 * pages" is exactly this table, queried by image key.
 *
 * Only block-level images are indexed (the ones the pipeline localizes and the
 * renderer rewrites per-language); inline icons and portraits are never
 * localized, so they don't need purge tracking. Banners are not here — their
 * image link is first-class on the `banners` table.
 */

import { and, eq, sql } from 'drizzle-orm';
import {
  check,
  index,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import { collectImages, imageKey, type Block } from '@hiroba/richtext';

import type { Database } from '../client';
// Type-only, so the queries.ts ↔ article-images.ts reference stays a
// compile-time cycle with no runtime import loop.
import type { ArticleType } from '../queries';

export const articleImages = sqliteTable(
  'article_images',
  {
    itemType: text('item_type').notNull(), // "news" | "topic" | "playguide"
    itemId: text('item_id').notNull(),
    // imageKey (`<host>/<path>`) — joins to images.key.
    imageKey: text('image_key').notNull(),
  },
  (table) => [
    // One link per (article, image). Article first so the PK also serves the
    // per-article replace on every blocks_ja write.
    primaryKey({
      columns: [table.itemType, table.itemId, table.imageKey],
    }),
    // Reverse lookup: "articles embedding this image" (the purge fan-out).
    index('article_images_by_key').on(table.imageKey),
    check(
      'article_images_type_valid',
      sql`${table.itemType} IN ('news', 'topic', 'playguide')`,
    ),
  ],
);

// Type exports
export type ArticleImage = typeof articleImages.$inferSelect;

/**
 * Replace an article's rows in the article_images reverse index from its block
 * tree. Called by every blocks_ja writer so the index can't drift. Only
 * block-level images are indexed (the localizable ones — see the header doc);
 * delete-then-insert as one atomic D1 batch, so a failure partway can't leave
 * the index emptied or half-written while blocks_ja still references the keys.
 *
 * The invalidate helpers (blocksJa → null pending refetch) deliberately do NOT
 * clear the index: the article still conceptually embeds those images, so a
 * purge in the window before the refetch over-includes a blockless page
 * (harmless) rather than under-purging if the refetch never lands. The next
 * real block write replaces the set.
 */
export async function syncArticleImages(
  db: Database,
  itemType: ArticleType,
  itemId: string,
  blocks: Block[],
): Promise<void> {
  const keys = [
    ...new Set(
      collectImages(blocks)
        .map((i) => imageKey(i.src))
        .filter((k): k is string => !!k),
    ),
  ];
  const del = db
    .delete(articleImages)
    .where(
      and(
        eq(articleImages.itemType, itemType),
        eq(articleImages.itemId, itemId),
      ),
    );
  // Inserts sliced to respect D1's per-query bind-parameter cap.
  const inserts = [];
  for (let i = 0; i < keys.length; i += 30) {
    inserts.push(
      db.insert(articleImages).values(
        keys.slice(i, i + 30).map((key) => ({
          itemType,
          itemId,
          imageKey: key,
        })),
      ),
    );
  }
  await db.batch([del, ...inserts]);
}
