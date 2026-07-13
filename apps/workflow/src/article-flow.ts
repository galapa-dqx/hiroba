/**
 * The ArticleFlow body — news items and topics on the flow framework (DQX-25),
 * the highest-volume consumer of the shared article-pipeline fragments.
 *
 * The body is intake + the two event steps + the shared tail, one altitude:
 * languages → fetch body → extract events → tag events → per-image ingest →
 * size-gated translate → per-image localize → edge purge. The image units
 * no-op when the document references no images (the case for news), so one
 * body serves both types — and the extracted event ids feed the translate
 * phase, which translates the event titles alongside the document.
 *
 * A failed body fetch (scrape reached the page but parsed nothing) settles the
 * run the way the old workflow did: the remaining steps are STORED skips and
 * the run completes with `fetchBody.success: false` — fetch-body already
 * marked the item's fetch state failed, so the web SSE settles too.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in article-workflow.ts, and this body runs under runFlowInline
 * in plain-node vitest.
 */

import { createDb, getEnabledLanguages } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type ArticleFlow } from '@hiroba/flows';

import {
  imageAndOutputPipeline,
  type ArticlePipelineEnv,
} from './article-pipeline';
import { extractAndSaveEvents } from './steps/extract-events';
import { fetchAndSaveArticleBody } from './steps/fetch-body';
import { tagArticleEvents } from './steps/tag-events';
import type { ArticleWorkflowOutput, ArticleWorkflowParams } from './types';

/** The slice of the worker env the body actually touches. */
export type ArticleFlowEnv = ArticlePipelineEnv;

export async function runArticleFlow(
  f: Flow<(typeof ArticleFlow)['steps']>,
  params: ArticleWorkflowParams,
  env: ArticleFlowEnv,
): Promise<ArticleWorkflowOutput> {
  const { itemId, itemType } = params;
  const db = createDb(env.DB);

  // The whitelist of target languages, read once (memoized) so every step
  // works on the same set even if the admin edits it mid-run.
  const languages = await f.step('loadLanguages', () =>
    getEnabledLanguages(db),
  );

  const fetchBody = await f.step('fetchBody', () =>
    fetchAndSaveArticleBody(db, itemType, itemId),
  );

  if (!fetchBody.success) {
    const reason = 'body fetch found no content';
    f.skip('extractEvents', reason);
    f.skip('tagEvents', reason);
    f.skip('images', reason);
    f.skip('translate', reason);
    f.skip('localizeImages', reason);
    f.skip('purge', reason);
    return {
      itemId,
      itemType,
      fetchBody,
      extractEvents: { count: 0, eventIds: [] },
      tagEvents: { tagged: false, timeTags: 0, eventTags: 0, retried: false },
      mirror: { mirrored: 0, skipped: 0, failed: 0 },
      transcribe: { imagesTranscribed: 0, failed: 0 },
      translate: { success: false, fieldsTranslated: 0 },
      localize: { localized: 0, skipped: 0, failed: 0 },
    };
  }

  // Calendar-event extraction (LLM over the RTML body), then the best-effort
  // inline <time>/<event> annotation of blocks_ja against those events.
  const extractEvents = await f.step('extractEvents', () =>
    extractAndSaveEvents(db, env.GEMINI_API_KEY, itemType, itemId),
  );

  const tagEvents = await f.step('tagEvents', () =>
    tagArticleEvents(
      db,
      env.GEMINI_API_KEY,
      itemType,
      itemId,
      extractEvents.eventIds,
    ),
  );

  const tail = await imageAndOutputPipeline(
    f,
    env,
    itemType,
    itemId,
    extractEvents.eventIds,
    languages,
  );

  return { itemId, itemType, fetchBody, extractEvents, tagEvents, ...tail };
}
