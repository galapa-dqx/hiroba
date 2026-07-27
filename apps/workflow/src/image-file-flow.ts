/**
 * The ImageFileFlow body — derived-file generation + page purge for one
 * already-written render (see the definition in @hiroba/flows for the why).
 * The encoding is the same buildDerivedFiles the mirror and localize steps run
 * inline; this flow is how a render written OUTSIDE this worker (the admin's
 * manual upload) reaches it.
 *
 * Error stance, per step. The register step tolerates the world moving on (a
 * vanished render or object records nothing; per-file encode/store failures
 * are absorbed inside buildDerivedFiles) but lets INFRASTRUCTURE errors — the
 * R2 read, the D1 batch — escape: the render row is already committed before
 * this flow starts, so a throw costs nothing and buys the engine's retries,
 * which is the whole reason this work runs in a workflow. No later pass exists
 * to pick up what a swallowed error would drop. The purge step never throws —
 * it's best-effort by construction, and a purge blip must not paint a red run
 * over an upload whose files actually landed.
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

import { buildDerivedFiles } from './image-files';
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
 * Encode + record one render's derived files, returning how many landed. Zero
 * is a real outcome (a vanished object, a GIF, an unshrinkable raster);
 * infrastructure errors THROW so the engine retries — see the module doc.
 */
async function registerDerivedFiles(
  db: Database,
  env: ImageFileFlowEnv,
  primaryKey: string,
  imageId: string,
): Promise<number> {
  const obj = await env.IMAGES_BUCKET.get(primaryKey);
  if (!obj) return 0;
  const bytes = new Uint8Array(await obj.arrayBuffer());
  const files = await buildDerivedFiles(
    env.IMAGES,
    env.IMAGES_BUCKET,
    primaryKey,
    bytes,
    obj.httpMetadata?.cacheControl ?? LOCALIZED_IMAGE_CACHE_CONTROL,
  );
  // An empty set records nothing and RETIRES nothing. Zero is ambiguous —
  // legitimately nothing to derive, or every encode failing during an Images
  // outage — and wiping the previous pass's rows on the latter would 404 the
  // <source> URLs cached HTML still embeds. Keeping possibly-stale rows is the
  // safe side: their objects still exist (they are only deleted when retired).
  if (files.length === 0) return 0;
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
    );
    return { files, sourceKey: render.sourceKey, language: render.language };
  });

  // Purge even when nothing was recorded: the render is already the served
  // one, so cached pages still carry the previous render's URL either way.
  // Originals (language NULL) have no per-language page set to purge — they
  // are only ever written by the mirror step, which needs no fan-out.
  await f.step('purge', async () => {
    if (!registered?.language) return;
    try {
      await purgeImagePages(
        env,
        db,
        registered.sourceKey,
        registered.language,
        {
          warn: (m) => console.warn(m),
          debug: () => {},
        },
      );
    } catch (err) {
      // Best-effort by contract: the D1 reads inside purgeImagePages can
      // throw, and a purge blip must not fail a run whose files landed —
      // pages refresh on their own TTL.
      console.warn(`image-file purge failed for ${registered.sourceKey}:`, err);
    }
  });

  return { imageId: params.imageId, files: registered?.files ?? 0 };
}
