/**
 * The ImageVariantFlow body — variant registration + page purge for one
 * stored render (see the definition in @hiroba/flows for the why). The
 * register step is the same registerImageSources the mirror and localize
 * steps call inline; this flow is how work that starts OUTSIDE this worker
 * (the admin's manual upload) reaches it.
 *
 * Both steps tolerate the world moving on: a vanished object registers
 * nothing (the web serves the render as a bare <img> until something
 * re-registers it), and the purge is best-effort by construction.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in image-variant-workflow.ts, and this body runs under
 * runFlowInline in plain-node vitest.
 */

import { createDb } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type ImageVariantFlow } from '@hiroba/flows';

import { registerImageSources } from './image-sources';
import { purgeImagePages, type PurgeEnv } from './purge';
import type {
  Env,
  ImageVariantWorkflowOutput,
  ImageVariantWorkflowParams,
} from './types';

/** The slice of the worker env the body actually touches. */
export type ImageVariantFlowEnv = Pick<Env, 'DB' | 'IMAGES_BUCKET' | 'IMAGES'> &
  PurgeEnv;

export async function runImageVariantFlow(
  f: Flow<(typeof ImageVariantFlow)['steps']>,
  params: ImageVariantWorkflowParams,
  env: ImageVariantFlowEnv,
): Promise<ImageVariantWorkflowOutput> {
  const db = createDb(env.DB);

  const registered = await f.step('register', async () => {
    const obj = await env.IMAGES_BUCKET.get(params.key);
    if (!obj) return false;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    await registerImageSources(
      db,
      env.IMAGES,
      env.IMAGES_BUCKET,
      params.key,
      bytes,
      obj.httpMetadata?.cacheControl ?? 'public, max-age=31536000, immutable',
      {
        fallbackMime: obj.httpMetadata?.contentType,
        sizes: params.sizes,
      },
    );
    return true;
  });

  // Purge even when nothing registered: the url row has already flipped, so
  // cached pages reference the previous render either way.
  await f.step('purge', () =>
    purgeImagePages(env, db, params.imageKey, params.language),
  );

  return { key: params.key, registered };
}
