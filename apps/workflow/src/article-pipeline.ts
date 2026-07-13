/**
 * Shared article-pipeline body helpers (DQX-24) — the flow-framework halves of
 * the old ArticleWorkflow, typed against the step-shape FRAGMENTS in
 * @hiroba/flows rather than any one flow. Any flow whose declared steps
 * structurally contain a fragment can hand its tracker here: PlayguideFlow
 * (DQX-24) and ArticleFlow (DQX-25) both do. This file is the reuse
 * mechanism — flows share bodies structurally, not by inheritance.
 *
 * What changed shape-wise from the old workflow:
 *   - mirror + transcribe collapse into ONE `images` map — one durable unit
 *     per referenced image (mirror into R2, then transcribe the baked-in
 *     text), replacing two one-big-steps whose internal mapWithConcurrency
 *     restarted every image on an engine retry. A retried step now re-runs
 *     only the unfinished units.
 *   - translate becomes a `phase`: one segment wrapping the size-gated
 *     sync/batch dance, with `poll` subsuming the sleep/check/budget loop.
 *   - localize becomes a per-image map (each unit bakes every enabled
 *     language for its image).
 *
 * Per-image failures keep the degrade-don't-block policy: the per-unit step
 * workers mark the image's D1 rows failed and RETURN (never throw), so a bad
 * image degrades the article without failing the run — and the unchanged D1
 * writes are exactly why computeSnapshot and the web SSE don't care which
 * engine ran the steps.
 *
 * Platform-free on purpose (no cloudflare:workers import): flow shells live in
 * *-workflow.ts files, and these helpers run under runFlowInline in
 * plain-node vitest.
 */

import { createDb, ensureImageRows, getImagesByKeys } from '@hiroba/db';
import type { Flow, PhaseStep } from '@hiroba/flow';
import type { articleImagework, articleOutput } from '@hiroba/flows';
import {
  collectImages,
  collectImageUrls,
  imageKey,
  type Block,
} from '@hiroba/richtext';

import { getArticle, getArticleBlocks } from './article';
import { createGemini } from './gemini';
import { purgeArticle, type PurgeEnv } from './purge';
import { localizeOneImage, type LocalizeResult } from './steps/localize-images';
import { mirrorOneImage, type MirrorResult } from './steps/mirror-images';
import { transcribeOneImage } from './steps/transcribe-images';
import {
  bodyMarkupSize,
  translateArticle,
  translateEventTitles,
  type TargetLanguage,
} from './steps/translate';
import {
  BATCH_MAX_POLLS,
  BATCH_POLL_INTERVAL,
  BATCH_TRANSLATE_THRESHOLD_CHARS,
  isBatchTerminal,
  pollBodyBatch,
  retrieveBodyBatch,
  submitBodyBatch,
} from './steps/translate-batch';
import type { Env, ItemType, TranscribeResult, TranslateResult } from './types';

/** The slice of the worker env the shared pipeline touches. */
export type ArticlePipelineEnv = Pick<
  Env,
  'DB' | 'IMAGES_BUCKET' | 'IMAGES' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY'
> &
  PurgeEnv;

/** Image-ingest units in flight (each is one CDN→R2 copy + one Gemini vision
 *  call) — the LLM half is the binding constraint, so the old transcribe cap. */
const IMAGE_INGEST_CONCURRENCY = 6;
/** Localize units in flight. Each unit works through EVERY enabled language
 *  for its image sequentially, so this bounds concurrent gpt-image-2 calls. */
const LOCALIZE_CONCURRENCY = 4;

/** What the pipeline tail produced — the output shape shared by every flow
 *  that spreads the imagework/output fragments. */
export type ArticlePipelineTail = {
  mirror: MirrorResult;
  transcribe: TranscribeResult;
  translate: TranslateResult;
  localize: LocalizeResult;
};

/** One `images` unit: what the ingest set contains for one image key. */
type ImageIngestItem = {
  key: string;
  /** Block images get transcribed; icon/bubble/responsive-source assets are
   *  mirror-only (matching the old steps' differing discovery walks). */
  transcribe: boolean;
};

/** The ingest unit set for a block tree: every mirrorable key, flagged with
 *  whether it's a transcription candidate. */
function imageIngestItems(blocks: Block[]): ImageIngestItem[] {
  const transcribable = new Set(
    collectImages(blocks)
      .map((img) => imageKey(img.src))
      .filter((k): k is string => !!k),
  );
  const items = new Map<string, ImageIngestItem>();
  for (const src of collectImageUrls(blocks)) {
    const key = imageKey(src);
    if (key && !items.has(key)) {
      items.set(key, { key, transcribe: transcribable.has(key) });
    }
  }
  return [...items.values()];
}

/**
 * Translate the document, routing by size — the `translate` phase body. Small
 * docs go through the synchronous whole-doc path (one engine step). An
 * oversized doc is submitted to the Gemini Batch API and polled across durable
 * sleeps until it settles — the instance costs nothing while waiting and
 * survives restarts — then its results are applied in a final step. Event
 * titles are small and always sync.
 */
export async function translateSizeGated(
  s: PhaseStep,
  env: Pick<ArticlePipelineEnv, 'DB' | 'GEMINI_API_KEY'>,
  itemType: ItemType,
  itemId: string,
  eventIds: string[],
  languages: TargetLanguage[],
): Promise<TranslateResult> {
  const db = createDb(env.DB);
  const apiKey = env.GEMINI_API_KEY;

  const plan = await s.do('plan', async () => {
    const item = await getArticle(db, itemType, itemId);
    const blocks = (item?.blocksJa ?? []) as Block[];
    const size = bodyMarkupSize(item ?? { titleJa: '' }, blocks);
    const mode = size > BATCH_TRANSLATE_THRESHOLD_CHARS ? 'batch' : 'sync';
    return { mode, size } as const;
  });

  if (plan.mode === 'sync') {
    return s.do('sync', () =>
      translateArticle(db, apiKey, itemType, itemId, eventIds, languages),
    );
  }

  const handle = await s.do('submit', async () => {
    const item = await getArticle(db, itemType, itemId);
    const blocks = (item?.blocksJa ?? []) as Block[];
    return submitBodyBatch(
      db,
      apiKey,
      itemType,
      itemId,
      item ?? { titleJa: '' },
      blocks,
      languages,
    );
  });

  const { settled } = await s.poll(
    'batch',
    { every: BATCH_POLL_INTERVAL, atMost: BATCH_MAX_POLLS },
    () => pollBodyBatch(apiKey, handle.batchName),
    isBatchTerminal,
  );
  if (!settled) {
    // Deliberately retrieve anyway: an unsettled batch at the budget ceiling
    // may still hold partial results, and retrieve settles the D1 states.
    console.warn(
      `translate batch ${handle.batchName} not settled after ${BATCH_MAX_POLLS} polls — retrieving anyway`,
    );
  }

  return s.do('retrieve', async () => {
    const item = await getArticle(db, itemType, itemId);
    const blocks = (item?.blocksJa ?? []) as Block[];
    const bodyFields = await retrieveBodyBatch(
      db,
      apiKey,
      itemType,
      itemId,
      item ?? { titleJa: '' },
      blocks,
      languages,
      handle.batchName,
    );
    // Event titles are short — translate them synchronously here.
    const eventFields = await translateEventTitles(
      db,
      createGemini(apiKey),
      eventIds,
      languages,
    );
    return {
      success: bodyFields > 0,
      fieldsTranslated: bodyFields + eventFields,
    };
  });
}

/**
 * The shared pipeline tail: per-image ingest (mirror + transcribe), the
 * size-gated translate phase, per-image localization, and the edge purge.
 * Typed against the imagework + output FRAGMENTS, so any flow whose shape
 * contains them can pass its tracker (structural typing).
 *
 * Localize runs even when translation reported failure (matching the old
 * workflow): candidates without translated text get their url rows marked
 * failed, settling the snapshot instead of leaving it waiting forever.
 */
export async function imageAndOutputPipeline(
  f: Flow<typeof articleImagework & typeof articleOutput>,
  env: ArticlePipelineEnv,
  itemType: ItemType,
  itemId: string,
  eventIds: string[],
  languages: TargetLanguage[],
): Promise<ArticlePipelineTail> {
  const db = createDb(env.DB);

  // One durable unit per referenced image: mirror into R2, then transcribe
  // the baked-in text (reading bytes back from the mirror — one CDN fetch per
  // image ever). The memoized list step is the replay-safe unit set, and it
  // doubles as the pipeline's image-discovery point: every key gets its
  // `images` row here, which is what feeds the "Downloading images (x/y)"
  // progress in the SSE snapshot.
  const ingested = await f.map(
    'images',
    async () => {
      const items = imageIngestItems(
        await getArticleBlocks(db, itemType, itemId),
      );
      await ensureImageRows(
        db,
        items.map((i) => i.key),
      );
      return items;
    },
    async (item) => {
      const mirror = await mirrorOneImage(db, env.IMAGES_BUCKET, item.key);
      // Transcribe even when the mirror failed — the loader falls back to a
      // direct CDN fetch, same as the old step.
      const transcribed = item.transcribe
        ? await transcribeOneImage(
            db,
            item.key,
            env.GEMINI_API_KEY,
            env.IMAGES_BUCKET,
          )
        : false;
      return { mirror, transcribed };
    },
    { concurrency: IMAGE_INGEST_CONCURRENCY, id: (item) => item.key },
  );

  const translate = await f.phase('translate', (s) =>
    translateSizeGated(s, env, itemType, itemId, eventIds, languages),
  );

  // One durable unit per transcription-candidate image; each unit bakes the
  // translations into the image for every enabled language.
  const localized = await f.map(
    'localizeImages',
    async () => {
      const keys = [
        ...new Set(
          collectImages(await getArticleBlocks(db, itemType, itemId))
            .map((img) => imageKey(img.src))
            .filter((k): k is string => !!k),
        ),
      ];
      return keys.length > 0 ? await getImagesByKeys(db, keys) : [];
    },
    (row) =>
      localizeOneImage(
        db,
        env.IMAGES_BUCKET,
        env.IMAGES,
        env.OPENAI_API_KEY,
        row,
        languages,
      ),
    { concurrency: LOCALIZE_CONCURRENCY, id: (row) => row.key },
  );

  // The article just (re)settled — bust the edge copies of its detail pages
  // across every language so readers see the update without waiting on the
  // long article TTL. Best-effort: purge swallows its own errors.
  await f.step('purge', () =>
    purgeArticle(env, itemType, itemId, languages, {
      warn: (m) => console.warn(m),
      debug: () => {},
    }),
  );

  const mirror: MirrorResult = { mirrored: 0, skipped: 0, failed: 0 };
  let imagesTranscribed = 0;
  for (const unit of ingested) {
    mirror[unit.mirror]++;
    if (unit.transcribed) imagesTranscribed++;
  }
  const localize: LocalizeResult = { localized: 0, skipped: 0, failed: 0 };
  for (const unit of localized) {
    localize.localized += unit.localized;
    localize.skipped += unit.skipped;
    localize.failed += unit.failed;
  }

  return { mirror, transcribe: { imagesTranscribed }, translate, localize };
}
