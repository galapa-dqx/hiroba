/**
 * Start the whole-archive TitleBackfillFlow for one language via the FlowHub's
 * fetch surface (DQX-13) — the admin "pre-warm" action, so a language can be
 * filled in before it's announced instead of waiting for the first visitor's
 * list view to arm it.
 *
 * The hub dedupes on the flow's language key, so this trigger and the on-view
 * ones attach to a run already in flight instead of doubling it. `force`
 * bypasses the list-view trigger's cooldown — an operator asked, so a fresh
 * run starts even if a page view attempted one moments ago. Fetch rather than
 * RPC: cross-script DO RPC is unsupported between local dev sessions.
 */

import { TitleBackfillFlow } from '@hiroba/flows';

export async function backfillLanguageTitles(
  namespace: DurableObjectNamespace,
  language: string,
): Promise<boolean> {
  try {
    const stub = namespace.get(namespace.idFromName('hub'));
    const res = await stub.fetch('http://internal/start', {
      method: 'POST',
      body: JSON.stringify({
        flow: TitleBackfillFlow.name,
        params: { language },
        force: true,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      console.error(
        `Failed to start ${language} title backfill: ${res.status}`,
      );
    }
    return res.ok;
  } catch (error) {
    console.error(`Failed to start ${language} title backfill:`, error);
    return false;
  }
}
