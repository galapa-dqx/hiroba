import { listNewsAdmin, listTopicsAdmin, type Database } from '@hiroba/db';

/** Upper bound on how many workflows one "translate recent N" action fans out to. */
export const MAX_RECENT_TRIGGER = 50;

/**
 * Trigger the ArticleWorkflow for the most-recent `count` items of a type by
 * POSTing each to its WorkflowManager DO instance — the DO dedupes an already
 * running/queued run, so re-triggering is safe. `count` is clamped to
 * [1, MAX_RECENT_TRIGGER]. Returns the ids triggered (newest first).
 *
 * Mirrors the per-item `/workflow` routes' DO naming: news instances are keyed
 * by the bare id, topics by `topic:${id}` (both ids are 32-char hex, so the
 * prefix keeps their DO instances from colliding).
 */
export async function triggerRecentWorkflows(
  db: Database,
  workflowManager: DurableObjectNamespace,
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
    const doName = itemType === 'topic' ? `topic:${id}` : id;
    const stub = workflowManager.get(workflowManager.idFromName(doName));
    await stub.fetch('http://internal/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Admin fan-out — force past the page-view re-trigger cooldown.
      body: JSON.stringify(
        itemType === 'topic'
          ? { itemId: id, itemType: 'topic', force: true }
          : { itemId: id, force: true },
      ),
    });
  }

  return { triggered: ids.length, ids };
}
