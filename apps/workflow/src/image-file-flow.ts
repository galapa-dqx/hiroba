/**
 * The ImageFileFlow body — derived-file generation + page purge for one
 * already-written render (see the definition in @hiroba/flows for the why).
 * The encoding is the same buildDerivedFiles the mirror and localize steps run
 * inline; this flow is how a render written OUTSIDE this worker (the admin's
 * manual upload) reaches it.
 *
 * Both steps tolerate the world moving on: a vanished render or object records
 * nothing (the raster serves as a bare <img> until something re-registers it),
 * and the purge is best-effort by construction. Neither throws — the render is
 * already reachable by the time this runs, so a failure here degrades the
 * markup, it never unwrites the upload.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in image-file-workflow.ts, and this body runs under
 * runFlowInline in plain-node vitest.
 */

import {
  createDb,
  getRenderWithSource,
  replaceDerivedFiles,
  type Database,
} from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type ImageFileFlow } from '@hiroba/flows';
import { LOCALIZED_IMAGE_CACHE_CONTROL } from '@hiroba/shared';

import { buildDerivedFiles, type DeriveOptions } from './image-files';
import { purgeImagePages, type PurgeEnv } from './purge';
import type {
  Env,
  ImageFileWorkflowOutput,
  ImageFileWorkflowParams,
} from './types';

/** The slice of the worker env the body actually touches. */
export type ImageFileFlowEnv = Pick<Env, 'DB' | 'IMAGES_BUCKET' | 'IMAGES'> &
  PurgeEnv;

/**
 * Encode + record one render's derived files, returning how many landed.
 * Never throws: zero is the same outcome a GIF or an unshrinkable raster
 * produces, and the caller purges either way.
 */
async function registerDerivedFiles(
  db: Database,
  env: ImageFileFlowEnv,
  primaryKey: string,
  imageId: string,
  opts: DeriveOptions,
): Promise<number> {
  try {
    const obj = await env.IMAGES_BUCKET.get(primaryKey);
    if (!obj) return 0;
    const bytes = new Uint8Array(await obj.arrayBuffer());
    const files = await buildDerivedFiles(
      env.IMAGES,
      env.IMAGES_BUCKET,
      primaryKey,
      bytes,
      obj.httpMetadata?.cacheControl ?? LOCALIZED_IMAGE_CACHE_CONTROL,
      opts,
    );
    // Replace rather than insert: a re-run whose encode outcomes differ must
    // retire the previous pass's rows. Rows fall out first, then their objects
    // — an orphaned object is benign debris, a row pointing at nothing is not.
    const stale = await replaceDerivedFiles(db, imageId, files);
    if (stale.length > 0) {
      try {
        await env.IMAGES_BUCKET.delete(stale);
      } catch (err) {
        console.warn(`stale file delete failed for ${primaryKey}:`, err);
      }
    }
    return files.length;
  } catch (err) {
    console.error(`derived-file registration failed for ${primaryKey}:`, err);
    return 0;
  }
}

export async function runImageFileFlow(
  f: Flow<(typeof ImageFileFlow)['steps']>,
  params: ImageFileWorkflowParams,
  env: ImageFileFlowEnv,
): Promise<ImageFileWorkflowOutput> {
  const db = createDb(env.DB);

  // The step also carries the purge scope forward, so the next step doesn't
  // re-read the row (step results round-trip through the engine's storage).
  const registered = await f.step('register', async () => {
    const render = await getRenderWithSource(db, params.imageId);
    if (!render) return null;
    const files = await registerDerivedFiles(
      db,
      env,
      render.primary.key,
      render.id,
      { fallbackMime: render.primary.mime, sizes: params.sizes },
    );
    return { files, sourceKey: render.sourceKey, language: render.language };
  });

  // Purge even when nothing was recorded: the render is already the served
  // one, so cached pages still carry the previous render's URL either way.
  // Originals (language NULL) have no per-language page set to purge — they
  // are only ever written by the mirror step, which needs no fan-out.
  await f.step('purge', async () => {
    if (!registered?.language) return;
    await purgeImagePages(env, db, registered.sourceKey, registered.language);
  });

  return { imageId: params.imageId, files: registered?.files ?? 0 };
}
