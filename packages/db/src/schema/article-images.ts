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

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

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
