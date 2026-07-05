/**
 * ArticleWorkflow — the unified multi-step pipeline for both news items and
 * topics, parameterized by item type.
 *
 * Steps (each reads inputs from D1, writes outputs to D1, returns minimal state):
 * 1. fetch-body        — scrape + parse the detail page → blocks_ja
 * 2. extract-events    — LLM calendar-event extraction (RTML input) → events
 * 3. mirror-images     — copy every referenced image into R2 (self-hosted)
 * 4. transcribe-images — Gemini vision reads baked-in image text → images table
 * 5. translate         — whole-document JA→EN → translations (title + content),
 *                        plus per-image spans and event titles
 * 6. localize-images   — bake the EN translations back into text-bearing images
 *
 * The image steps (mirror/transcribe/localize) no-op when the document
 * references no images — the case for news — so one pipeline serves both types.
 * Mirroring runs before transcription so transcribe reads bytes from R2 (one CDN
 * fetch per image ever); transcription lands in blocks' image rows before
 * translation so the image text is translated in-context (via <figure>);
 * localization runs last, needing the EN spans the translate step produced.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import { createDb, failPipelineStates } from '@hiroba/db';

import { getArticleBlocks } from './article';
import { createLogger, runStep } from './logger';
import { extractAndSaveEvents } from './steps/extract-events';
import { fetchAndSaveArticleBody } from './steps/fetch-body';
import { localizeImages } from './steps/localize-images';
import { mirrorImages } from './steps/mirror-images';
import { tagArticleEvents } from './steps/tag-events';
import { transcribeImages } from './steps/transcribe-images';
import { translateArticle } from './steps/translate';
import type {
  ArticleWorkflowOutput,
  ArticleWorkflowParams,
  Env,
  ItemType,
} from './types';

export class ArticleWorkflow extends WorkflowEntrypoint<
  Env,
  ArticleWorkflowParams
> {
  async run(
    event: WorkflowEvent<ArticleWorkflowParams>,
    step: WorkflowStep,
  ): Promise<ArticleWorkflowOutput> {
    const { itemId, itemType } = event.payload;
    const db = createDb(this.env.DB);
    const log = createLogger(this.env, `${itemType}:${itemId}`);

    try {
      return await this.runSteps(itemType, itemId, db, log, step);
    } catch (err) {
      // Terminal workflow failure (a step exhausted its retries): settle every
      // state this item still holds open so SSE clients and later triggers see
      // failed, not an eternal running. Shared image rows settle themselves.
      await step.do('mark-failed', async () => {
        await failPipelineStates(
          db,
          itemType,
          itemId,
          'en',
          err instanceof Error ? err.message : 'workflow failed',
        );
      });
      throw err;
    }
  }

  private async runSteps(
    itemType: ItemType,
    itemId: string,
    db: ReturnType<typeof createDb>,
    log: ReturnType<typeof createLogger>,
    step: WorkflowStep,
  ): Promise<ArticleWorkflowOutput> {
    // Step 1: fetch + parse the detail page → blocks_ja
    const fetchBody = await runStep(step, log, 'fetch-body', () =>
      fetchAndSaveArticleBody(db, itemType, itemId),
    );

    // If fetch failed, skip remaining steps.
    if (!fetchBody.success) {
      return {
        itemId,
        itemType,
        fetchBody,
        extractEvents: { count: 0, eventIds: [] },
        tagEvents: { tagged: false, timeTags: 0, eventTags: 0, retried: false },
        mirror: { mirrored: 0, skipped: 0, failed: 0 },
        transcribe: { imagesTranscribed: 0 },
        translate: { success: false, fieldsTranslated: 0 },
        localize: { localized: 0, skipped: 0, failed: 0 },
      };
    }

    // Step 2: extract calendar events from the RTML serialization → events
    const extractEvents = await runStep(step, log, 'extract-events', () =>
      extractAndSaveEvents(db, this.env.GEMINI_API_KEY, itemType, itemId),
    );

    // Step 2.5: annotate blocks_ja with inline <time>/<event> tags linking the
    // prose to the extracted events (best-effort; runs before translate so
    // blocks_en inherits the tags).
    const tagEvents = await runStep(step, log, 'tag-events', () =>
      tagArticleEvents(
        db,
        this.env.GEMINI_API_KEY,
        itemType,
        itemId,
        extractEvents.eventIds,
      ),
    );

    // Step 3: mirror every referenced image into R2 (no-op when the doc has none)
    const mirror = await runStep(step, log, 'mirror-images', async () =>
      mirrorImages(
        db,
        this.env.IMAGES_BUCKET,
        await getArticleBlocks(db, itemType, itemId),
      ),
    );

    // Step 4: transcribe baked-in image text into the images table (deduped by
    // key across articles). Reads bytes from the R2 mirror.
    const transcribe = await runStep(
      step,
      log,
      'transcribe-images',
      async () => {
        const imagesTranscribed = await transcribeImages(
          db,
          await getArticleBlocks(db, itemType, itemId),
          this.env.GEMINI_API_KEY,
          this.env.IMAGES_BUCKET,
        );
        return { imagesTranscribed };
      },
    );

    // Step 5: translate the (now transcribed) document, its image spans, and
    // the event titles extracted in step 2.
    const translate = await runStep(step, log, 'translate', () =>
      translateArticle(
        db,
        this.env.GEMINI_API_KEY,
        itemType,
        itemId,
        extractEvents.eventIds,
      ),
    );

    // Step 6: bake the EN translations back into text-bearing images (no-op when
    // the doc has none). Runs even when translation failed: candidates without
    // EN text then get their url rows marked failed, settling the snapshot.
    const localize = await runStep(step, log, 'localize-images', async () =>
      localizeImages(
        db,
        this.env.IMAGES_BUCKET,
        this.env.IMAGES,
        this.env.OPENAI_API_KEY,
        await getArticleBlocks(db, itemType, itemId),
      ),
    );

    return {
      itemId,
      itemType,
      fetchBody,
      extractEvents,
      tagEvents,
      mirror,
      transcribe,
      translate,
      localize,
    };
  }
}
