import { listNewsAdmin, listTopicsAdmin, type Database } from '@hiroba/db';
import { ArticleFlow } from '@hiroba/flows';

import { startFlowViaHub } from './start-flow';
import { MAX_RECENT_TRIGGER } from './trigger-limits';

/**
 * Trigger the ArticleFlow for the most-recent `count` items of a type via the
 * FlowHub (DQX-25) — the hub dedupes on the `${itemType}:${itemId}` key, so an
 * already running item is attached to, never doubled, and re-triggering is
 * safe. `force` skips the page-view cooldown (this is an operator fan-out).
 * `count` is clamped to [1, MAX_RECENT_TRIGGER]. Returns the ids triggered
 * (newest first).
 */
export async function triggerRecentWorkflows(
  db: Database,
  flowHub: DurableObjectNamespace,
  itemType: 'news' | 'topic',
  count: number,
): Promise<{ triggered: number; ids: string[] }> {
  const n = Math.min(Math.max(Math.floor(count), 1), MAX_RECENT_TRIGGER);
  const { items } =
    itemType === 'topic'
      ? await listTopicsAdmin(db, { limit: n })
      : await listNewsAdmin(db, { limit: n });
  const ids = items.map((i) => i.id);

  for (const id of ids) {
    await startFlowViaHub(
      flowHub,
      ArticleFlow.name,
      { itemId: id, itemType },
      { force: true },
    );
  }

  return { triggered: ids.length, ids };
}
