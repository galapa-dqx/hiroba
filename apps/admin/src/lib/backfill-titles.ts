/**
 * Ask the workflow worker (via the WorkflowManager DO's /backfill-titles route)
 * to run the whole-archive TitleBackfillWorkflow for one language (DQX-13) —
 * the admin "pre-warm" action, so a language can be filled in before it's
 * announced instead of waiting for the first visitor's list view to arm it.
 *
 * Routes to the per-language `title-backfill:<lang>` DO instance so the DO's
 * dedup sees this trigger alongside the on-view ones (same instance).
 */
export async function backfillLanguageTitles(
  namespace: DurableObjectNamespace,
  language: string,
): Promise<boolean> {
  try {
    const stub = namespace.get(
      namespace.idFromName(`title-backfill:${language}`),
    );
    const res = await stub.fetch('http://internal/backfill-titles', {
      method: 'POST',
      body: JSON.stringify({ language }),
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
