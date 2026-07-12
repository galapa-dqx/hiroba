/**
 * Web-side interface to the WorkflowManager Durable Object — the one place
 * that knows the DO naming convention: a news item's DO is named by its bare
 * id; topics and playguides are namespaced `<type>:<id>` so they can't collide
 * with a news item (or each other) of the same id.
 */

import type { ItemType } from '@hiroba/db';
import { TitleBackfillFlow } from '@hiroba/flows';

type ArticleType = Extract<ItemType, 'news' | 'topic' | 'playguide'>;

type Runtime = App.Locals['runtime'];

function workflowStub(runtime: Runtime, itemType: ArticleType, id: string) {
  const name = itemType === 'news' ? id : `${itemType}:${id}`;
  const doId = runtime.env.WORKFLOW_MANAGER.idFromName(name);
  return runtime.env.WORKFLOW_MANAGER.get(doId);
}

/**
 * Fire-and-forget trigger for an article's pipeline (the DO ignores the
 * trigger when a run is already in flight). Failures are logged, not thrown —
 * the page still renders whatever content it has.
 */
export function triggerWorkflow(
  runtime: Runtime,
  itemType: ArticleType,
  id: string,
): void {
  try {
    const stub = workflowStub(runtime, itemType, id);
    stub.fetch('http://internal/trigger', {
      method: 'POST',
      body: JSON.stringify({ itemId: id, itemType }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(`Workflow trigger failed for ${itemType} ${id}:`, error);
  }
}

/**
 * How many untranslated titles a list view must show before it kicks off the
 * whole-archive backfill (DQX-13). A caught-up language only lags on the newest
 * item or two (DQX-11 discovery), which stays under this; a freshly-enabled
 * language shows a whole page of JA fallbacks, which clears it. Small enough
 * that a language that's genuinely behind self-heals on the next visit.
 */
export const BACKFILL_TITLE_THRESHOLD = 5;

/**
 * Minimum gap between page-driven backfill starts for one language. A run in
 * flight is always attached to regardless (the hub dedupes on the language
 * key); this throttles the case where a run already finished but left
 * stragglers the model kept dropping — still over the threshold, so every
 * organic list view would otherwise start a fresh scan. Mirrors the article
 * pipeline's re-trigger cooldown; the admin pre-warm bypasses it with `force`.
 */
const BACKFILL_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fire-and-forget the language's title backfill via the FlowHub, which dedupes
 * on the flow's language key: a backfill already in flight is attached to,
 * never doubled. Mirrors triggerWorkflow: failures are logged, never thrown —
 * the list still renders its JA fallbacks.
 */
export function triggerTitleBackfill(runtime: Runtime, language: string): void {
  try {
    const ns = runtime.env.FLOW_HUB;
    const stub = ns.get(ns.idFromName('hub'));
    stub.fetch('http://internal/start', {
      method: 'POST',
      body: JSON.stringify({
        flow: TitleBackfillFlow.name,
        params: { language },
        cooldownMs: BACKFILL_COOLDOWN_MS,
      }),
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error(`Title backfill trigger failed for ${language}:`, error);
  }
}

/**
 * Arm the backfill from a rendered list when enough of its titles are still
 * untranslated. Counts the JA fallbacks (`titleEn === null`) in the items the
 * page already fetched — no extra query — and triggers only past the threshold,
 * so a caught-up language never fires it.
 */
export function maybeTriggerTitleBackfill(
  runtime: Runtime,
  language: string,
  items: ReadonlyArray<{ titleEn: string | null }>,
): void {
  const missing = items.reduce((n, i) => (i.titleEn === null ? n + 1 : n), 0);
  if (missing >= BACKFILL_TITLE_THRESHOLD) {
    triggerTitleBackfill(runtime, language);
  }
}

/** Proxy the DO's SSE progress stream for an article (the api sse routes). */
export async function proxyWorkflowSse(
  runtime: Runtime,
  itemType: ArticleType,
  id: string,
  language?: string,
): Promise<Response> {
  const stub = workflowStub(runtime, itemType, id);
  const langParam = language ? `&language=${encodeURIComponent(language)}` : '';
  const res = await stub.fetch(
    `http://internal/sse?itemId=${id}&itemType=${itemType}${langParam}`,
  );

  return new Response(res.body, {
    status: res.status,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
