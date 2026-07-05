/**
 * Article loading helpers shared across the unified pipeline steps.
 *
 * News and topics are stored in separate tables (`news_items` / `topics`) but
 * carry the same body-bearing shape — `title_ja`, `published_at`, and the
 * canonical `blocks_ja` tree. The pipeline reads through these helpers so each
 * step stays parameterized by item type without duplicating the table branch.
 */

import {
  getNewsItem,
  getTopic,
  type Database,
  type NewsItem,
  type Topic,
} from '@hiroba/db';
import type { Block } from '@hiroba/richtext';

import type { ItemType } from './types';

/** The common article row (news item or topic) selected by item type. */
export async function getArticle(
  db: Database,
  itemType: ItemType,
  id: string,
): Promise<NewsItem | Topic | null> {
  return itemType === 'topic' ? getTopic(db, id) : getNewsItem(db, id);
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
