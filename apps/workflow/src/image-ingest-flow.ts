/**
 * The ImageIngestFlow body — shared per-image ingest (mirror → transcribe) as
 * a child flow (DQX-27), keyed by the image key so every parent referencing
 * the same image joins ONE run. Parents `mapJoin` this def with settled
 * semantics: a failed image degrades the article, never blocks it — and the
 * step workers here uphold their half of that policy by marking the image's
 * D1 rows failed and RETURNING, never throwing, for domain failures (the D1
 * writes are unchanged, which is why the web SSE snapshot doesn't care which
 * flow ran the work).
 *
 * `transcribe: false` (icon/bubble/responsive-source assets) stores a skip:
 * the run decided not to, and the segment strip says so.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in image-ingest-workflow.ts, and this body runs under
 * runFlowInline in plain-node vitest.
 */

import { createDb, ensureImageRows } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type ImageIngestFlow } from '@hiroba/flows';

import { mirrorOneImage } from './steps/mirror-images';
import { transcribeOneImage } from './steps/transcribe-images';
import type {
  Env,
  ImageIngestWorkflowOutput,
  ImageIngestWorkflowParams,
} from './types';

/** The slice of the worker env the body actually touches. */
export type ImageIngestFlowEnv = Pick<
  Env,
  'DB' | 'IMAGES_BUCKET' | 'GEMINI_API_KEY'
>;

export async function runImageIngestFlow(
  f: Flow<(typeof ImageIngestFlow)['steps']>,
  params: ImageIngestWorkflowParams,
  env: ImageIngestFlowEnv,
): Promise<ImageIngestWorkflowOutput> {
  const { imageKey, transcribe } = params;
  const db = createDb(env.DB);

  const mirror = await f.step('mirror', async () => {
    // Self-contained discovery: the parent's list step ensures rows for its
    // whole set (the SSE progress denominator), but this child must not
    // depend on which parent started it.
    await ensureImageRows(db, [imageKey]);
    return mirrorOneImage(db, env.IMAGES_BUCKET, imageKey);
  });

  if (!transcribe) {
    f.skip('transcribe', 'not a transcription candidate');
    return { imageKey, mirror, transcribed: false, transcribeFailed: false };
  }

  // Transcribe even when the mirror failed — the loader falls back to a
  // direct CDN fetch, same as the in-flow units did.
  const outcome = await f.step('transcribe', () =>
    transcribeOneImage(db, imageKey, env.GEMINI_API_KEY, env.IMAGES_BUCKET),
  );

  return {
    imageKey,
    mirror,
    transcribed: outcome === 'transcribed',
    transcribeFailed: outcome === 'failed',
  };
}
