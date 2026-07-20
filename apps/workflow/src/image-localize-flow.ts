/**
 * The ImageLocalizeFlow body — one image baked into one language (DQX-27),
 * keyed `${imageKey}:${lang}` so every article sharing the image joins ONE
 * generation instead of racing gpt-image-2 twice. Parents start it after
 * their translate phase (the generation reads the translated spans that phase
 * wrote to D1); translation itself stays article-scoped — whole-document
 * in-context translation of image text is the point.
 *
 * Domain failures never throw: `localizeImageLanguage` marks the image's
 * `url` translation row failed and returns the outcome, because a failed
 * image degrades the article, never blocks it. The one body-level failure —
 * an image row that doesn't exist at all (ingest never ran for this key) —
 * settles the same way, as a failed outcome.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in image-localize-workflow.ts, and this body runs under
 * runFlowInline in plain-node vitest.
 */

import { createDb, getImageSourcesByKeys, getLanguageLabel } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type ImageLocalizeFlow } from '@hiroba/flows';

import { localizeImageLanguage } from './steps/localize-images';
import type {
  Env,
  ImageLocalizeWorkflowOutput,
  ImageLocalizeWorkflowParams,
} from './types';

/** The slice of the worker env the body actually touches. */
export type ImageLocalizeFlowEnv = Pick<
  Env,
  'DB' | 'IMAGES_BUCKET' | 'IMAGES' | 'OPENAI_API_KEY'
>;

export async function runImageLocalizeFlow(
  f: Flow<(typeof ImageLocalizeFlow)['steps']>,
  params: ImageLocalizeWorkflowParams,
  env: ImageLocalizeFlowEnv,
): Promise<ImageLocalizeWorkflowOutput> {
  const { imageKey, lang } = params;
  const db = createDb(env.DB);

  const outcome = await f.step('generate', async () => {
    const [row] = await getImageSourcesByKeys(db, [imageKey]);
    if (!row) return 'failed' as const;
    // Params carry only the code (it's the dedup key); the prompt label comes
    // from the whitelist, degrading to the code for an unknown language.
    const label = await getLanguageLabel(db, lang);
    return localizeImageLanguage(
      db,
      env.IMAGES_BUCKET,
      env.IMAGES,
      env.OPENAI_API_KEY,
      row,
      { code: lang, label },
    );
  });

  return { imageKey, lang, outcome };
}
