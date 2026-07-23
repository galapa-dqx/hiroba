/**
 * The GlossaryRegenFlow body — refresh everything affected by a changed
 * glossary term: the articles that quote it and the images that bake it in
 * (DQX-21, the keyed-dedup + keyset-handle flow).
 *
 * When an admin edits a glossary override, content already translated with the
 * old term needs re-doing so it picks up the new one. There can be many — a
 * common term appears in hundreds of bodies — far more than one request's
 * subrequest budget can handle inline. So the flow owns the scan: params carry
 * only the term, and each set is keyset-paged one durable unit per page, so
 * engine checkpointing gives resume-on-failure for free and the whole affected
 * set is covered with no cap.
 *
 * Steps (declared in @hiroba/flows' GlossaryRegenFlow):
 * 1. scanArticles      — keyset-page the article ids whose blocks_ja contain
 *                        the term, per item type. Driven through the `open`
 *                        handle: page N+1 needs page N's cursor, so map/drain
 *                        (where the pool owns the counter) don't apply.
 * 2. retriggerArticles — re-run each match's flow as a JOINED child (DQX-27):
 *                        each unit starts-or-attaches via the hub (dedup on
 *                        the flow key, so an already running/queued run is
 *                        attached to) and AWAITS its terminal state. The
 *                        segment's units are the child runs themselves — real
 *                        aggregate progress — and this run completing means
 *                        the regeneration actually finished, not merely got
 *                        enqueued. Settled semantics: a failed article is
 *                        counted (`retriggerFailed`), never blocks the rest.
 * 3. languages         — load the enabled-language whitelist once, so every
 *                        image page translates into the same set even if the
 *                        admin edits it mid-run.
 * 4. retranslateImages — keyset-page the images whose baked-in Japanese
 *                        contains the term and re-translate each page's stored
 *                        `text` translations in place. The localized raster
 *                        (`url`) is intentionally *not* regenerated — an
 *                        override edit changes the words we store for
 *                        generation, not the (expensive) picture; a later
 *                        explicit image regeneration bakes the fresh text in.
 *                        Re-translation is idempotent (it just overwrites the
 *                        row), so this pass is safe under retries too.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in glossary-regenerate-workflow.ts, and this body runs under
 * runFlowInline in plain-node vitest.
 */

import { createDb, getEnabledLanguages } from '@hiroba/db';
import { joinRequest, type Flow, type JoinRequest } from '@hiroba/flow';
import {
  ArticleFlow,
  PlayguideFlow,
  type GlossaryRegenFlow,
} from '@hiroba/flows';

import {
  findArticlesContainingSourcePage,
  findImagesContainingSourcePage,
} from './glossary-regen-queries';
import { retranslateImageTexts } from './steps/translate-image-texts';
import type {
  Env,
  GlossaryRegenerateWorkflowOutput,
  GlossaryRegenerateWorkflowParams,
  ItemType,
} from './types';

/** Article ids scanned per page = per durable unit — just a query LIMIT here
 *  (each trigger is its own engine step with its own budget). */
export const GLOSSARY_REGENERATE_BATCH_SIZE = 100;

/**
 * Images re-translated per page = per durable unit. Smaller than the article
 * batch: each image costs one Gemini call *per enabled language*, so a page of
 * this size keeps a unit within its subrequest and time budget even with
 * several languages enabled.
 */
export const GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE = 25;

/** Concurrent article JOINS in flight — bounds in-flight child runs (the real
 *  constraint is LLM rate limits, same as the old paged triggers). */
const TRIGGER_CONCURRENCY = 10;

const ITEM_TYPES: readonly ItemType[] = ['news', 'topic', 'playguide'];

/** The slice of the worker env the body actually touches (joins go through
 *  the tracker's JoinPort, so the hub binding is no longer read here). */
export type GlossaryRegenFlowEnv = Pick<Env, 'DB' | 'GEMINI_API_KEY'>;

export async function runGlossaryRegenFlow(
  f: Flow<(typeof GlossaryRegenFlow)['steps']>,
  params: GlossaryRegenerateWorkflowParams,
  env: GlossaryRegenFlowEnv,
): Promise<GlossaryRegenerateWorkflowOutput> {
  const { sourceText } = params;
  const db = createDb(env.DB);

  // 1. Scan for affected articles, one keyset page per unit.
  const scan = f.open('scanArticles');
  await scan.expect(null);
  // Closure-accumulated across engine steps — which LOOKS like the forbidden
  // pattern (state must cross step boundaries via step returns, never
  // closures). It's replay-safe here BECAUSE every push comes from a memoized
  // `open`-handle unit return: on replay the units answer from memo without
  // re-querying, and this body code re-runs the pushes deterministically. The
  // map's own memoized list step below then freezes the set for good.
  const affected: Array<{ itemType: ItemType; itemId: string }> = [];
  for (const itemType of ITEM_TYPES) {
    // Keyset cursor: the last id of the previous page. Triggering a match
    // doesn't drop it from the scan set, so we page by `id > cursor` rather
    // than re-querying from the top (which would loop forever).
    let afterId: string | null = null;
    for (let page = 0; ; page++) {
      const ids = await scan.unit(`${itemType}:${page}`, () =>
        findArticlesContainingSourcePage(
          db,
          sourceText,
          itemType,
          afterId,
          GLOSSARY_REGENERATE_BATCH_SIZE,
        ),
      );
      if (ids.length === 0) break;
      affected.push(...ids.map((itemId) => ({ itemType, itemId })));
      afterId = ids[ids.length - 1];

      // A short page is the last one — no need for one more empty scan.
      if (ids.length < GLOSSARY_REGENERATE_BATCH_SIZE) break;
    }
  }
  await scan.done();

  // 2. Re-run every affected article as a joined child (playguide = slug key,
  // article = `${itemType}:${itemId}` key): each unit starts-or-attaches via
  // the hub and awaits the child's terminal state, so the segment counts
  // FINISHED regenerations and this run completing means the work is done.
  // Settled semantics — one failed article is counted, never blocks the rest.
  const retriggered = await f.mapJoin(
    'retriggerArticles',
    async () => affected,
    (a) => childRequest(a.itemType, a.itemId),
    {
      concurrency: TRIGGER_CONCURRENCY,
      id: (a) => `${a.itemType}:${a.itemId}`,
    },
  );
  const retriggerFailed = retriggered.filter(
    (outcome) => outcome.status === 'failed',
  ).length;

  // 3+4. Refresh the stored `text` translation of every image whose baked-in
  // Japanese contains the term, one keyset page at a time. Scan and translate
  // are separate units so a translate retry reuses the memoized page instead
  // of re-scanning.
  const languages = await f.step('languages', () => getEnabledLanguages(db));

  const images = f.open('retranslateImages');
  await images.expect(null);
  let imagesRetranslated = 0;
  // Keyset cursor: the last id of the previous page (images.id is numeric).
  let afterImageId: number | null = null;
  for (let page = 0; ; page++) {
    const rows = await images.unit(`scan-${page}`, () =>
      findImagesContainingSourcePage(
        db,
        sourceText,
        afterImageId,
        GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE,
      ),
    );
    if (rows.length === 0) break;

    const result = await images.unit(`translate-${page}`, () =>
      retranslateImageTexts(db, env.GEMINI_API_KEY, rows, languages),
    );
    imagesRetranslated += result.translated;
    afterImageId = rows[rows.length - 1].id;

    if (rows.length < GLOSSARY_REGENERATE_IMAGE_BATCH_SIZE) break;
  }
  await images.done();

  return {
    sourceText,
    triggered: affected.length,
    retriggerFailed,
    imagesRetranslated,
  };
}

/** The join request for one affected item — the same flow-and-params routing
 *  every trigger surface uses (playguide = slug, article = typed id). */
function childRequest(itemType: ItemType, id: string): JoinRequest {
  return itemType === 'playguide'
    ? joinRequest(PlayguideFlow, { slug: id })
    : joinRequest(ArticleFlow, { itemId: id, itemType });
}
