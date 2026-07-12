import {
  findArticlesContainingSource,
  type ArticleType,
  type Database,
} from '@hiroba/db';

/** Upper bound on how many workflows one "regenerate affected texts" action fans out to. */
export const MAX_REGENERATE_TRIGGER = 200;

/**
 * WorkflowManager DO instance name for an article, matching the per-item
 * `/workflow` routes' naming: news keyed by the bare id, topics by `topic:${id}`,
 * playguides by `playguide:${slug}` (so the different id spaces never collide).
 */
function doNameFor(itemType: ArticleType, id: string): string {
  switch (itemType) {
    case 'topic':
      return `topic:${id}`;
    case 'playguide':
      return `playguide:${id}`;
    default:
      return id;
  }
}

/**
 * Re-run the ArticleWorkflow for every fetched article whose Japanese body
 * contains `sourceText` — the glossary "regenerate affected texts" action. Finds
 * the matches (capped at {@link MAX_REGENERATE_TRIGGER}) and POSTs each to its
 * WorkflowManager DO, which dedupes an already running/queued run so this is safe
 * to re-trigger. Returns the ids triggered and whether the match cap was hit.
 */
export async function regenerateArticlesForSource(
  db: Database,
  workflowManager: DurableObjectNamespace,
  sourceText: string,
): Promise<{
  triggered: number;
  hasMore: boolean;
  items: Array<{ itemType: ArticleType; id: string }>;
}> {
  const { items, hasMore } = await findArticlesContainingSource(
    db,
    sourceText,
    MAX_REGENERATE_TRIGGER,
  );

  for (const { itemType, id } of items) {
    const stub = workflowManager.get(
      workflowManager.idFromName(doNameFor(itemType, id)),
    );
    await stub.fetch('http://internal/trigger', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemId: id, itemType }),
    });
  }

  return { triggered: items.length, hasMore, items };
}
