/**
 * Web-side interface to the article pipelines: fire-and-forget triggers via
 * the FlowHub (which owns dedup and the re-trigger cooldown), and the SSE
 * progress proxy to the workflow worker's plain domain SSE route (DQX-26).
 */

import type { ItemType } from '@hiroba/db';
import { ArticleFlow, PlayguideFlow, TitleBackfillFlow } from '@hiroba/flows';

type ArticleType = Extract<ItemType, 'news' | 'topic' | 'playguide'>;

type Runtime = App.Locals['runtime'];

/**
 * Minimum gap between page-driven pipeline re-triggers for one article. A
 * settled-but-degraded article is not complete, so every organic view would
 * otherwise start a fresh pipeline. Mirrors the workflow worker's
 * RETRIGGER_COOLDOWN_MS.
 */
const RETRIGGER_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fire-and-forget trigger for an article's pipeline. Failures are logged, not
 * thrown — the page still renders whatever content it has.
 *
 * Every pipeline runs on the flow framework (DQX-24/25): the start goes to
 * the FlowHub, which dedupes on the flow key (playguide = slug, article =
 * `${itemType}:${itemId}` — a run in flight is attached to, never doubled)
 * and throttles page-driven re-triggers of settled runs via the cooldown.
 */
export function triggerWorkflow(
  runtime: Runtime,
  itemType: ArticleType,
  id: string,
): void {
  try {
    const start =
      itemType === 'playguide'
        ? { flow: PlayguideFlow.name, params: { slug: id } }
        : { flow: ArticleFlow.name, params: { itemId: id, itemType } };
    const ns = runtime.env.FLOW_HUB;
    const stub = ns.get(ns.idFromName('hub'));
    stub.fetch('http://internal/start', {
      method: 'POST',
      body: JSON.stringify({
        ...start,
        cooldownMs: RETRIGGER_COOLDOWN_MS,
      }),
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
 * key); this throttles SETTLED runs — a completed scan that left stragglers
 * the model kept dropping (still over the threshold, so every organic list
 * view would otherwise start a fresh scan), and, deliberately, a FAILED one:
 * a backfill that exhausted its retries means the translation backend is
 * down, and re-launching a whole-archive scan per page view during an outage
 * only amplifies it (the old DO path restarted immediately; this is the fix,
 * not a regression). Lists stay on their JA fallbacks either way, the next
 * window self-heals, and the admin pre-warm bypasses with `force`. Mirrors
 * the article pipeline's re-trigger cooldown.
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

/** Proxy the workflow worker's SSE progress stream for an article (the api
 *  sse routes). */
export async function proxyWorkflowSse(
  runtime: Runtime,
  itemType: ArticleType,
  id: string,
  language?: string,
): Promise<Response> {
  const langParam = language ? `&language=${encodeURIComponent(language)}` : '';
  const res = await runtime.env.WORKFLOW.fetch(
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
