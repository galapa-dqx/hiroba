/**
 * D1 query owned by the banner flow (see banner-flow.ts) — its only consumer,
 * so it lives here rather than in @hiroba/db (DQX-53).
 */

import { and, eq, notInArray } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import { banners, type Database } from '@hiroba/db';

/** A banner as scraped from the source rotation page. */
export type BannerListItem = {
  imageKey: string;
  linkUrl: string | null;
  linkTopicId: string | null;
  altJa: string;
  sortOrder: number;
  publishedAt: Temporal.Instant | null;
};

/**
 * Upsert the current rotation banners (keyed by imageKey), marking each active,
 * then deactivate any banner no longer in the set — so the carousel reflects the
 * live rotation while keeping stale rows (and their localized images) around.
 */
export async function syncBanners(
  db: Database,
  items: BannerListItem[],
): Promise<void> {
  const now = Temporal.Now.instant();
  for (const item of items) {
    await db
      .insert(banners)
      .values({ ...item, active: true, updatedAt: now })
      .onConflictDoUpdate({
        target: banners.imageKey,
        set: {
          linkUrl: item.linkUrl,
          linkTopicId: item.linkTopicId,
          altJa: item.altJa,
          sortOrder: item.sortOrder,
          publishedAt: item.publishedAt,
          active: true,
          updatedAt: now,
        },
      });
  }

  const keep = items.map((i) => i.imageKey);
  await db
    .update(banners)
    .set({ active: false, updatedAt: now })
    .where(
      keep.length > 0
        ? and(eq(banners.active, true), notInArray(banners.imageKey, keep))
        : eq(banners.active, true),
    );
}
