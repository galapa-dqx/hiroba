/**
 * GlossaryRegenerateWorkflow — re-translate every article affected by a changed
 * glossary term.
 *
 * When an admin edits a glossary override, the articles already translated with
 * the old term need re-running so they pick up the new one. There can be many —
 * a common term appears in hundreds of bodies — far more than one request's
 * subrequest budget can trigger inline. So, like the other backfill workflows,
 * this owns the scan: params carry only the term, and each item type is paged
 * by keyset (`findArticlesContainingSourcePage`) one durable step per page, so
 * Cloudflare Workflows checkpointing gives resume-on-failure for free and the
 * whole affected set is covered with no cap.
 *
 * Each page's ids are re-triggered through their per-item WorkflowManager DO,
 * which dedupes an already running/queued run — so this is idempotent, safe to
 * re-fire, and safe under step retries (a retried trigger step just re-triggers
 * already-running articles, which the DO no-ops).
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import { createDb, findArticlesContainingSourcePage } from '@hiroba/db';

import { mapWithConcurrency } from './concurrency';
import { createLogger, runStep } from './logger';
import type {
  Env,
  GlossaryRegenerateWorkflowOutput,
  GlossaryRegenerateWorkflowParams,
  ItemType,
} from './types';

/**
 * Article ids scanned per page = per durable step. Each id costs one DO fetch
 * (the DO does the ArticleWorkflow create on its own subrequest budget), so a
 * page of this size stays comfortably within a step's subrequest limit.
 */
export const GLOSSARY_REGENERATE_BATCH_SIZE = 100;

/** Concurrent DO triggers within one page — overlap the round-trips, don't burst. */
const TRIGGER_CONCURRENCY = 10;

const ITEM_TYPES: readonly ItemType[] = ['news', 'topic', 'playguide'];

export class GlossaryRegenerateWorkflow extends WorkflowEntrypoint<
  Env,
  GlossaryRegenerateWorkflowParams
> {
  async run(
    event: WorkflowEvent<GlossaryRegenerateWorkflowParams>,
    step: WorkflowStep,
  ): Promise<GlossaryRegenerateWorkflowOutput> {
    const { sourceText } = event.payload;
    const db = createDb(this.env.DB);
    const log = createLogger(this.env, `glossary-regen:${sourceText}`);

    let triggered = 0;
    for (const itemType of ITEM_TYPES) {
      // Keyset cursor: the last id of the previous page. Triggering a match
      // doesn't drop it from the scan set, so we page by `id > cursor` rather
      // than re-querying from the top (which would loop forever).
      let afterId: string | null = null;
      for (let page = 0; ; page++) {
        const ids = await runStep(step, log, `scan:${itemType}:${page}`, () =>
          findArticlesContainingSourcePage(
            db,
            sourceText,
            itemType,
            afterId,
            GLOSSARY_REGENERATE_BATCH_SIZE,
          ),
        );
        if (ids.length === 0) break;

        await runStep(step, log, `trigger:${itemType}:${page}`, () =>
          this.triggerBatch(itemType, ids),
        );
        triggered += ids.length;
        afterId = ids[ids.length - 1];

        // A short page is the last one — no need for one more empty scan.
        if (ids.length < GLOSSARY_REGENERATE_BATCH_SIZE) break;
      }
    }

    log.info(
      `glossary-regen:${sourceText} re-triggered ${triggered} article(s)`,
    );
    return { sourceText, triggered };
  }

  /**
   * Re-run the ArticleWorkflow for each id through its per-item WorkflowManager
   * DO (bounded concurrency), which dedupes an already running/queued run.
   * Returns a count so the step result is Serializable.
   */
  private async triggerBatch(
    itemType: ItemType,
    ids: string[],
  ): Promise<{ triggered: number }> {
    await mapWithConcurrency(ids, TRIGGER_CONCURRENCY, async (id) => {
      // DO naming mirrors the per-item /workflow routes: news = bare id,
      // topic/playguide = `<type>:<id>` (their id spaces would otherwise collide).
      const doName = itemType === 'news' ? id : `${itemType}:${id}`;
      const stub = this.env.WORKFLOW_MANAGER.get(
        this.env.WORKFLOW_MANAGER.idFromName(doName),
      );
      await stub.fetch('http://internal/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: id, itemType }),
      });
    });
    return { triggered: ids.length };
  }
}
