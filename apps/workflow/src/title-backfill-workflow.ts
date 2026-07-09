/**
 * TitleBackfillWorkflow — whole-archive title translation for one language
 * (DQX-13).
 *
 * DQX-11's TitleWorkflow keeps *newly discovered* titles translated; this fills
 * the existing archive (all news categories + the ~168 months of topics
 * backnumbers) the first time a language needs it. It is fired lazily — the
 * first list view in an under-translated language kicks it off via the
 * WorkflowManager DO (which dedupes per language) — and can be pre-warmed from
 * the admin before a language is announced.
 *
 * The workflow owns the scan: params carry only the language, and each item
 * type is paged newest-first through getUntranslatedTitles, one durable step
 * per page so Cloudflare Workflows checkpointing gives resume-on-failure for
 * free. Each page is translated by the same glossary-aware translateTitleChunk
 * the discovery workflow uses. It is idempotent — already-translated titles
 * have a value and drop out of the scan, so a re-run only touches what's still
 * missing, which is also what makes it safe as a self-healing retry when the
 * hourly cron's title batch (DQX-11) drops something.
 *
 * There is no cursor: a translated title gains a value and leaves the scan set,
 * so the next scan returns the next-newest untranslated page. A page that
 * translates nothing (every id dropped by the model) would otherwise repeat
 * forever, so the loop stops the moment a page makes no forward progress —
 * those stragglers stay on their JA fallback for a later run or first view.
 *
 * On terminal failure (a chunk exhausted its retries) the cleanup resets any
 * titles left `running` for this language back to `pending`, so nothing is
 * stuck; lists stay on the JA fallback and the next run (or first view) picks
 * them up.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import {
  createDb,
  getUntranslatedTitles,
  resetRunningTitlesForLanguage,
} from '@hiroba/db';

import { createLogger, runStep } from './logger';
import { translateTitleChunk } from './steps/translate-titles';
import type {
  Env,
  ItemType,
  TitleBackfillWorkflowOutput,
  TitleBackfillWorkflowParams,
} from './types';

/**
 * Titles per backfill page = per LLM call = per durable step. Larger than the
 * discovery batch (titles are short, so this is well within a request): fewer
 * steps to page a multi-thousand-title archive, still small enough to bound a
 * retried step and the blast radius of one dropped response.
 */
export const TITLE_BACKFILL_BATCH_SIZE = 100;

const ITEM_TYPES: readonly ItemType[] = ['news', 'topic'];

export class TitleBackfillWorkflow extends WorkflowEntrypoint<
  Env,
  TitleBackfillWorkflowParams
> {
  async run(
    event: WorkflowEvent<TitleBackfillWorkflowParams>,
    step: WorkflowStep,
  ): Promise<TitleBackfillWorkflowOutput> {
    const { language } = event.payload;
    const db = createDb(this.env.DB);
    const log = createLogger(this.env, `title-backfill:${language}`);

    let scanned = 0;
    let translated = 0;
    let failed = 0;

    try {
      for (const itemType of ITEM_TYPES) {
        for (let page = 0; ; page++) {
          const batch = await runStep(
            step,
            log,
            `scan:${itemType}:${page}`,
            () =>
              getUntranslatedTitles(
                db,
                itemType,
                language,
                TITLE_BACKFILL_BATCH_SIZE,
              ),
          );
          if (batch.length === 0) break;

          scanned += batch.length;
          const outcome = await runStep(
            step,
            log,
            `translate:${itemType}:${page}`,
            () =>
              translateTitleChunk(
                db,
                this.env.GEMINI_API_KEY,
                itemType,
                language,
                batch,
              ),
          );
          translated += outcome.translated;
          failed += outcome.failed;

          // No title advanced — every id in this page was dropped by the model.
          // The scan set won't shrink, so stop rather than re-page it forever.
          if (outcome.translated === 0) {
            log.warn(
              `title-backfill:${language} ${itemType}: no progress on ${batch.length} title(s); stopping`,
            );
            break;
          }
        }
      }
      return { language, scanned, translated, failed };
    } catch (err) {
      // A chunk exhausted its retries — clear any titles left `running` for
      // this language so nothing is stuck mid-flight.
      await step.do('reset-running', () =>
        resetRunningTitlesForLanguage(db, language),
      );
      throw err;
    }
  }
}
