/**
 * Start the TitleFlow over newly-discovered items via the FlowHub's fetch
 * surface, so admin-triggered list scrapes eagerly translate titles just like
 * the hourly cron. The flow's key is random — every discovery batch is its own
 * disjoint id set, so starts never attach to a run in flight. Fetch rather
 * than RPC: cross-script DO RPC is unsupported between local dev sessions.
 * Best-effort: a failure to enqueue is logged and must never fail the scrape
 * that found the items.
 */

import { TitleFlow } from '@hiroba/flows';

export async function enqueueTitleTranslation(
  namespace: DurableObjectNamespace,
  itemType: 'news' | 'topic' | 'playguide',
  itemIds: string[],
): Promise<boolean> {
  if (itemIds.length === 0) return true;
  try {
    const stub = namespace.get(namespace.idFromName('hub'));
    const res = await stub.fetch('http://internal/start', {
      method: 'POST',
      body: JSON.stringify({
        flow: TitleFlow.name,
        params: { itemType, itemIds },
      }),
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
