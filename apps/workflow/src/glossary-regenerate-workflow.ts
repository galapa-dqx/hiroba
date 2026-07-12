/**
 * GlossaryRegenerateWorkflow — refresh everything affected by a changed glossary
 * term: the articles that quote it and the images that bake it in.
 *
 * When an admin edits a glossary override, content already translated with the
 * old term needs re-doing so it picks up the new one. There can be many — a
 * common term appears in hundreds of bodies — far more than one request's
 * subrequest budget can handle inline. So, like the other backfill workflows,
 * this owns the scan: params carry only the term, and each set is paged by
 * keyset one durable step per page, so Cloudflare Workflows checkpointing gives
 * resume-on-failure for free and the whole affected set is covered with no cap.
 *
 * Two passes:
 *  - Articles (`findArticlesContainingSourcePage`): each page's ids are
 *    re-triggered through their per-item WorkflowManager DO, which dedupes an
 *    already running/queued run — idempotent, safe to re-fire, safe under step
 *    retries (a retried trigger just re-triggers already-running articles, which
 *    the DO no-ops).
 *  - Images (`findImagesContainingSourcePage`): each match's stored `text`
 *    translation is re-translated in place (`retranslateImageTexts`) so the spans
 *    localize would bake reflect the edited override. The localized raster
 *    (`url`) is intentionally *not* regenerated — an override edit changes the
 *    words we store for generation, not the (expensive) picture; a later explicit
 *    image regeneration bakes the fresh text in. Re-translation is idempotent
 *    (it just overwrites the row), so this pass is also safe under step retries.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import {
  createDb,
  findArticlesContainingSourcePage,
  findImagesContainingSourcePage,
  getEnabledLanguages,
} from '@hiroba/db';

import { mapWithConcurrency } from './concurrency';
import { createLogger, runStep } from './logger';
import { retranslateImageTexts } from './steps/translate-image-texts';
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

/**
 * Images re-translated per page = per durable step. Smaller than the article
 * batch: each image costs one Gemini call *per enabled language* (not a single
 * cheap DO fetch), so a page of this size keeps a step within its subrequest and
 * time budget even with several languages enabled.
 */
export const GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE = 25;

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

    // Pass 1 — re-trigger every affected article.
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

    // Pass 2 — refresh the stored `text` translation of every image whose
    // baked-in Japanese contains the term. Read the language whitelist once so
    // every page translates into the same set even if the admin edits it mid-run.
    const languages = await runStep(step, log, 'load-languages', () =>
      getEnabledLanguages(db),
    );
    let imagesRetranslated = 0;
    // Keyset cursor: the last id of the previous page (images.id is numeric).
    let afterImageId: number | null = null;
    for (let page = 0; ; page++) {
      const rows = await runStep(step, log, `scan-images:${page}`, () =>
        findImagesContainingSourcePage(
          db,
          sourceText,
          afterImageId,
          GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE,
        ),
      );
      if (rows.length === 0) break;

      const result = await runStep(
        step,
        log,
        `retranslate-images:${page}`,
        () =>
          retranslateImageTexts(db, this.env.GEMINI_API_KEY, rows, languages),
      );
      imagesRetranslated += result.translated;
      afterImageId = rows[rows.length - 1].id;

      if (rows.length < GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE) break;
    }

    log.info(
      `glossary-regen:${sourceText} re-triggered ${triggered} article(s), ` +
        `re-translated ${imagesRetranslated} image text(s)`,
    );
    return { sourceText, triggered, imagesRetranslated };
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
      const res = await stub.fetch('http://internal/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId: id, itemType }),
      });
      // A failed trigger must not be silently counted as done — throw so the
      // step retries (triggering is idempotent: the DO dedupes an already
      // running/queued run). If retries are exhausted the workflow errors,
      // surfacing an incomplete regeneration rather than hiding it.
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(
          `trigger ${itemType} ${id} failed: ${res.status}${detail ? ` ${detail}` : ''}`,
        );
      }
    });
    // mapWithConcurrency only resolves if every trigger above succeeded, so the
    // whole batch really was (re-)triggered.
    return { triggered: ids.length };
  }
}
