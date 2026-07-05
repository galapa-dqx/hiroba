/**
 * TitleWorkflow — durable title translation at discovery (DQX-11).
 *
 * Discovery is titles-only: the hourly cron scrapes lists, upserts items, and
 * enqueues this workflow so list pages read in the target language before anyone
 * opens the article. The heavy ArticleWorkflow (body, images, whole-document
 * translation) stays lazy — triggered on first view — and re-translates the
 * title with full context, which wins.
 *
 * Titles are read fresh from the item's table (params carry only ids), then
 * translated in TITLE_BATCH_SIZE-sized chunks, one durable step per chunk per
 * language. A chunk step that throws (transport/API error) is retried by the
 * platform; if it exhausts its retries the run fails, and the cleanup resets any
 * titles left `running` back to `pending` so nothing is stuck (lists stay on JA;
 * first view or the backfill will translate them).
 *
 * The same workflow is the intended home for DQX-13's multi-language backfill —
 * it just receives a larger id set and more languages.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import { createDb, getItemTitles, resetRunningTitles } from '@hiroba/db';

import { createLogger, runStep } from './logger';
import {
  TITLE_BATCH_SIZE,
  translateTitleChunk,
} from './steps/translate-titles';
import type { Env, TitleWorkflowOutput, TitleWorkflowParams } from './types';

export class TitleWorkflow extends WorkflowEntrypoint<
  Env,
  TitleWorkflowParams
> {
  async run(
    event: WorkflowEvent<TitleWorkflowParams>,
    step: WorkflowStep,
  ): Promise<TitleWorkflowOutput> {
    const { itemType, itemIds, languages } = event.payload;
    const db = createDb(this.env.DB);
    const log = createLogger(this.env, `titles:${itemType}`);

    if (itemIds.length === 0) return { itemType, translated: 0, failed: 0 };

    try {
      // Read current titles once (cached across replays); params carry only ids.
      const items = await runStep(step, log, 'load-titles', () =>
        getItemTitles(db, itemType, itemIds),
      );

      let translated = 0;
      let failed = 0;
      for (const language of languages) {
        for (let i = 0; i < items.length; i += TITLE_BATCH_SIZE) {
          const chunk = items.slice(i, i + TITLE_BATCH_SIZE);
          const outcome = await runStep(
            step,
            log,
            `translate:${language}:${i / TITLE_BATCH_SIZE}`,
            () =>
              translateTitleChunk(
                db,
                this.env.GEMINI_API_KEY,
                itemType,
                language,
                chunk,
              ),
          );
          translated += outcome.translated;
          failed += outcome.failed;
        }
      }
      return { itemType, translated, failed };
    } catch (err) {
      // A chunk exhausted its retries — reset any titles still `running` back to
      // `pending` so nothing is stuck. Only running rows are touched, so already
      // translated chunks keep their `done`.
      await step.do('reset-running', async () => {
        for (const language of languages) {
          await resetRunningTitles(db, itemType, itemIds, language);
        }
      });
      throw err;
    }
  }
}
