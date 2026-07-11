/**
 * Article loading helpers shared across the unified pipeline steps.
 *
 * News and topics are stored in separate tables (`news_items` / `topics`) but
 * carry the same body-bearing shape — `title_ja`, `published_at`, and the
 * canonical `blocks_ja` tree. The pipeline reads through these helpers so each
 * step stays parameterized by item type without duplicating the table branch.
 */

import { eq } from 'drizzle-orm';

import {
  getNewsItem,
  getPlayguide,
  getTopic,
  newsItems,
  updatePlayguideBlocks,
  updateTopicBlocks,
  type Database,
  type NewsItem,
  type Playguide,
  type Topic,
} from '@hiroba/db';
import type { Block } from '@hiroba/richtext';

import type { ItemType } from './types';

/** The common article row (news item, topic, or playguide) selected by item type. */
export async function getArticle(
  db: Database,
  itemType: ItemType,
  id: string,
): Promise<NewsItem | Topic | Playguide | null> {
  return itemType === 'topic'
    ? getTopic(db, id)
    : itemType === 'playguide'
      ? getPlayguide(db, id)
      : getNewsItem(db, id);
}

/**
 * The article's canonical JA block tree (empty when the body isn't fetched).
 * Re-read inside each step body so it survives workflow replay/hibernation.
 */
export async function getArticleBlocks(
  db: Database,
  itemType: ItemType,
  id: string,
): Promise<Block[]> {
  const item = await getArticle(db, itemType, id);
  return (item?.blocksJa ?? []) as Block[];
}

/**
 * Overwrite the article's canonical JA block tree (used by the tag-events step
 * to persist time/event annotations).
 */
export async function saveArticleBlocks(
  db: Database,
  itemType: ItemType,
  id: string,
  blocks: Block[],
): Promise<void> {
  if (itemType === 'topic') {
    await updateTopicBlocks(db, id, blocks);
  } else if (itemType === 'playguide') {
    await updatePlayguideBlocks(db, id, blocks);
  } else {
    await db
      .update(newsItems)
      .set({ blocksJa: blocks })
      .where(eq(newsItems.id, id));
  }
}
