/**
 * Shared article-pipeline body helpers (DQX-24) — the flow-framework halves of
 * the old ArticleWorkflow, typed against the step-shape FRAGMENTS in
 * @hiroba/flows rather than any one flow. Any flow whose declared steps
 * structurally contain a fragment can hand its tracker here: PlayguideFlow
 * (DQX-24) and ArticleFlow (DQX-25) both do. This file is the reuse
 * mechanism — flows share bodies structurally, not by inheritance.
 *
 * What changed shape-wise from the old workflow:
 *   - mirror + transcribe collapse into ONE `images` mapJoin — one unit per
 *     referenced image, each unit a JOIN on the shared per-image
 *     ImageIngestFlow child (DQX-27). Keyed by the image key, so two articles
 *     referencing the same image attach to ONE child run: the hub's dedup
 *     replaces the D1 image-row state machine as the cross-article
 *     coordination point.
 *   - translate becomes a `phase`: one segment wrapping the size-gated
 *     sync/batch dance, with `poll` subsuming the sleep/check/budget loop.
 *     Translation stays article-scoped — whole-document in-context
 *     translation of image text is the point.
 *   - localize becomes a mapJoin over (image, language) pairs on the
 *     ImageLocalizeFlow child, started after translate (the generation needs
 *     the spans that phase wrote) and shared the same way.
 *
 * Per-image failures keep the degrade-don't-block policy, now as explicit
 * code instead of implicit D1 row states: mapJoin is always SETTLED — a
 * failed child becomes a failed outcome in the collected results, counted
 * into the tail's totals, and the run carries on. The children's step workers
 * still mark the image's D1 rows failed rather than throw, so the admin
 * image panels don't care which flow ran the work.
 *
 * Platform-free on purpose (no cloudflare:workers import): flow shells live in
 * *-workflow.ts files, and these helpers run under runFlowInline in
 * plain-node vitest.
 */

import { createDb, ensureImageRows, getImagesByKeys } from '@hiroba/db';
import { joinRequest, type Flow, type PhaseStep } from '@hiroba/flow';
import {
  ImageIngestFlow,
  ImageLocalizeFlow,
  type articleImagework,
  type articleOutput,
} from '@hiroba/flows';
import {
  collectImages,
  collectImageUrls,
  imageKey,
  type Block,
} from '@hiroba/richtext';
import { hasJapanese } from '@hiroba/shared';

import { getArticle, getArticleBlocks } from './article';
import { createGemini } from './gemini';
import { purgeArticle, type PurgeEnv } from './purge';
import type { LocalizeResult } from './steps/localize-images';
import type { MirrorResult } from './steps/mirror-images';
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
import type {
  Env,
  ImageIngestWorkflowOutput,
  ImageLocalizeWorkflowOutput,
  ItemType,
  TranscribeResult,
  TranslateResult,
} from './types';

/** The slice of the worker env the shared pipeline touches. The image work
 *  runs in the joined children now, so the R2/Images/OpenAI bindings left
 *  with it — what remains is D1, the translate phase's LLM, and the purge. */
export type ArticlePipelineEnv = Pick<Env, 'DB' | 'GEMINI_API_KEY'> & PurgeEnv;

/** Ingest joins in flight — bounds how fast this parent CREATES child runs
 *  (each child is one CDN→R2 copy + one Gemini vision call; the LLM half is
 *  the binding constraint, so the old transcribe cap). */
const IMAGE_INGEST_CONCURRENCY = 6;
/** Localize joins in flight. Units are (image, language) pairs now, each one
 *  gpt-image-2 generation, so this bounds concurrent generations directly. */
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
async function translateSizeGated(
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
 * The shared pipeline tail: per-image ingest joins (mirror + transcribe in
 * the shared ImageIngestFlow child), the size-gated translate phase,
 * per-(image, language) localize joins on ImageLocalizeFlow, and the edge
 * purge. Typed against the imagework + output FRAGMENTS, so any flow whose
 * shape contains them can pass its tracker (structural typing).
 *
 * Localize runs even when translation reported failure (matching the old
 * workflow): candidates without translated text get their url rows marked
 * failed by the child, settling the snapshot instead of leaving it waiting
 * forever.
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

  // One unit per referenced image, each a JOIN on the shared per-image ingest
  // child — settled semantics, so a failed image degrades the article, never
  // blocks it. The memoized list step is the replay-safe unit set, and it
  // doubles as the pipeline's image-discovery point: every key gets its
  // `images` row here, which is what feeds the "Downloading images (x/y)"
  // progress in the SSE snapshot (the child re-ensures its own row, but only
  // the full set here gives the denominator up front).
  const ingested = await f.mapJoin<ImageIngestItem, ImageIngestWorkflowOutput>(
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
    (item) =>
      joinRequest(ImageIngestFlow, {
        imageKey: item.key,
        transcribe: item.transcribe,
      }),
    { concurrency: IMAGE_INGEST_CONCURRENCY, id: (item) => item.key },
  );

  const translate = await f.phase('translate', (s) =>
    translateSizeGated(s, env, itemType, itemId, eventIds, languages),
  );

  // One unit per (transcribed-Japanese image, enabled language) pair, each a
  // JOIN on the shared per-(image, language) generation child. Filtered to
  // images whose ingest actually found Japanese — a textless image has
  // nothing to generate, and its child runs would be pure overhead across
  // every language.
  const localized = await f.mapJoin<
    { key: string; lang: string },
    ImageLocalizeWorkflowOutput
  >(
    'localizeImages',
    async () => {
      const keys = [
        ...new Set(
          collectImages(await getArticleBlocks(db, itemType, itemId))
            .map((img) => imageKey(img.src))
            .filter((k): k is string => !!k),
        ),
      ];
      const rows = keys.length > 0 ? await getImagesByKeys(db, keys) : [];
      // Plain-literal pairs, never the rows themselves: the memoized unit set
      // is engine-serialized, and a full row's Temporal.Instant updatedAt
      // isn't serializable (the child re-reads its row from D1 instead).
      return rows
        .filter((row) => !!row.textsJa && hasJapanese(row.textsJa))
        .flatMap((row) =>
          languages.map((lang) => ({ key: row.key, lang: lang.code })),
        );
    },
    (pair) =>
      joinRequest(ImageLocalizeFlow, { imageKey: pair.key, lang: pair.lang }),
    {
      concurrency: LOCALIZE_CONCURRENCY,
      id: (pair) => `${pair.key}:${pair.lang}`,
    },
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

  // A failed JOIN (child run failed/unknown — its step workers never throw
  // for domain failures, so this means real trouble) counts into the same
  // `failed` buckets a failed image always filled: degrade, don't block.
  const mirror: MirrorResult = { mirrored: 0, skipped: 0, failed: 0 };
  const transcribe: TranscribeResult = { imagesTranscribed: 0, failed: 0 };
  for (const outcome of ingested) {
    if (outcome.status === 'complete' && outcome.output) {
      mirror[outcome.output.mirror]++;
      if (outcome.output.transcribed) transcribe.imagesTranscribed++;
      if (outcome.output.transcribeFailed) transcribe.failed++;
    } else {
      mirror.failed++;
    }
  }
  const localize: LocalizeResult = { localized: 0, skipped: 0, failed: 0 };
  for (const outcome of localized) {
    if (outcome.status === 'complete' && outcome.output) {
      localize[outcome.output.outcome]++;
    } else {
      localize.failed++;
    }
  }

  return { mirror, transcribe, translate, localize };
}
