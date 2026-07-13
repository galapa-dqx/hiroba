/**
 * Item-type ↔ pipeline-flow mapping for the body-bearing article types
 * (news/topic/playguide) — the one place that knows which flow drives which
 * item type, and how to recover the item from a hub run's identity.
 */

import type { RunInfo } from '@hiroba/flow/hub';
import { ArticleFlow, itemFlowStart, PlayguideFlow } from '@hiroba/flows';

import type { ItemType } from './types';

/** The body-bearing item types whose pipelines the domain routes serve. */
export const ARTICLE_ITEM_TYPES = ['news', 'topic', 'playguide'] as const;

/** Parse a wire `itemType` string to a pipeline item type (news default). */
export function parseItemType(value: string | null | undefined): ItemType {
  return (ARTICLE_ITEM_TYPES as readonly string[]).includes(value ?? '')
    ? (value as ItemType)
    : 'news';
}

/** The hub start arguments for one item's pipeline — playguides run their own
 *  flow keyed by slug; news/topics run the ArticleFlow keyed by type+id.
 *  (The mapping itself lives in @hiroba/flows so web/admin share it.) */
export const flowStart = itemFlowStart;

/** Whether a hub run is one of the item pipelines (vs a generic flow). */
export function isItemFlow(flow: string): boolean {
  return flow === ArticleFlow.name || flow === PlayguideFlow.name;
}

/** The (itemType, itemId) a hub run is about, recovered from its identity. */
export function hubRunItem(run: RunInfo): {
  itemType: ItemType;
  itemId: string;
} {
  if (run.flow === PlayguideFlow.name) {
    return { itemType: 'playguide', itemId: run.key };
  }
  // ArticleFlow params travel verbatim through the hub.
  const params = run.params as { itemType?: string; itemId?: string } | null;
  return {
    itemType: parseItemType(params?.itemType),
    itemId: params?.itemId ?? run.key,
  };
}
