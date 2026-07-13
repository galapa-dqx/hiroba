/**
 * The PlayguideFlow body — playguides split out of the old unified
 * ArticleWorkflow as their own flow (DQX-24), the first consumer of the shared
 * article-pipeline fragments.
 *
 * The body is intake + the shared tail, one altitude, no scaffolding:
 * languages → fetch body → per-image ingest → size-gated translate →
 * per-image localize → edge purge. No event steps exist to skip — playguides
 * are static reference pages with no dated events, and the fragment
 * composition means they were never declared (the `itemType === 'playguide'`
 * branches the old workflow carried are gone with them).
 *
 * A failed body fetch (scrape reached the page but parsed nothing) settles the
 * run the way the old workflow did: the remaining steps are STORED skips and
 * the run completes with `fetchBody.success: false` — fetch-body already
 * marked the item's fetch state failed, so the web SSE settles too.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in playguide-workflow.ts, and this body runs under runFlowInline
 * in plain-node vitest.
 */

import { createDb, getEnabledLanguages } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type PlayguideFlow } from '@hiroba/flows';

import {
  imageAndOutputPipeline,
  type ArticlePipelineEnv,
} from './article-pipeline';
import { fetchAndSaveArticleBody } from './steps/fetch-body';
import type { PlayguideWorkflowOutput, PlayguideWorkflowParams } from './types';

/** The slice of the worker env the body actually touches. */
export type PlayguideFlowEnv = ArticlePipelineEnv;

export async function runPlayguideFlow(
  f: Flow<(typeof PlayguideFlow)['steps']>,
  params: PlayguideWorkflowParams,
  env: PlayguideFlowEnv,
): Promise<PlayguideWorkflowOutput> {
  const { slug } = params;
  const db = createDb(env.DB);

  // The whitelist of target languages, read once (memoized) so every step
  // works on the same set even if the admin edits it mid-run.
  const languages = await f.step('loadLanguages', () =>
    getEnabledLanguages(db),
  );

  const fetchBody = await f.step('fetchBody', () =>
    fetchAndSaveArticleBody(db, 'playguide', slug),
  );

  if (!fetchBody.success) {
    const reason = 'body fetch found no content';
    f.skip('images', reason);
    f.skip('translate', reason);
    f.skip('localizeImages', reason);
    f.skip('purge', reason);
    return {
      slug,
      fetchBody,
      mirror: { mirrored: 0, skipped: 0, failed: 0 },
      transcribe: { imagesTranscribed: 0, failed: 0 },
      translate: { success: false, fieldsTranslated: 0 },
      localize: { localized: 0, skipped: 0, failed: 0 },
    };
  }

  const tail = await imageAndOutputPipeline(
    f,
    env,
    'playguide',
    slug,
    // Playguides have no extracted events, so nothing feeds event-title
    // translation.
    [],
    languages,
  );

  return { slug, fetchBody, ...tail };
}
