/**
 * Ask the workflow worker (via the WorkflowManager DO's /enqueue-titles route)
 * to run the durable TitleWorkflow over newly-discovered items, so
 * admin-triggered list scrapes eagerly translate titles just like the hourly
 * cron. Best-effort: a failure to enqueue is logged and must never fail the
 * scrape that found the items.
 */
export async function enqueueTitleTranslation(
  namespace: DurableObjectNamespace,
  itemType: 'news' | 'topic',
  itemIds: string[],
): Promise<boolean> {
  if (itemIds.length === 0) return true;
  try {
    // Global state only, so the well-known 'registry' instance serves it
    // (same convention as the /runs tracker).
    const stub = namespace.get(namespace.idFromName('registry'));
    const res = await stub.fetch('http://internal/enqueue-titles', {
      method: 'POST',
      body: JSON.stringify({ itemType, itemIds }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.error(
        `Failed to enqueue ${itemType} title translation: ${res.status}`,
      );
    }
    return res.ok;
  } catch (error) {
    console.error(`Failed to enqueue ${itemType} title translation:`, error);
    return false;
  }
}
