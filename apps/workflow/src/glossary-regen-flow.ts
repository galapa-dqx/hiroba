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
 * 2. retriggerArticles — re-run each match's ArticleWorkflow through its
 *                        per-item WorkflowManager DO, which dedupes an already
 *                        running/queued run — idempotent, safe to re-fire.
 *                        (Phase 5 — see DQX-21 — turns these into `join`s on
 *                        the article flow; until then the DO path stands.)
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

import {
  createDb,
  findArticlesContainingSourcePage,
  findImagesContainingSourcePage,
  getEnabledLanguages,
} from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type GlossaryRegenFlow } from '@hiroba/flows';

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

/** Concurrent trigger units in flight — overlap the round-trips, don't burst. */
const TRIGGER_CONCURRENCY = 10;

const ITEM_TYPES: readonly ItemType[] = ['news', 'topic', 'playguide'];

/** The slice of the worker env the body actually touches. */
export type GlossaryRegenFlowEnv = Pick<
  Env,
  'DB' | 'GEMINI_API_KEY' | 'WORKFLOW_MANAGER'
>;

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

  // 2. Re-trigger every affected article through its per-item WorkflowManager
  // DO, which dedupes an already running/queued run — a retried unit just
  // re-triggers an already-running article, which the DO no-ops.
  await f.map(
    'retriggerArticles',
    async () => affected,
    (a) => triggerArticle(env, a.itemType, a.itemId),
    {
      concurrency: TRIGGER_CONCURRENCY,
      id: (a) => `${a.itemType}:${a.itemId}`,
    },
  );

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

  return { sourceText, triggered: affected.length, imagesRetranslated };
}

/**
 * Re-run one article's ArticleWorkflow through its per-item WorkflowManager DO.
 * Returns a truthy marker (a unit return must be Serializable, and the
 * introspector drops a nullish mock); a failed trigger throws so the unit
 * retries rather than being silently counted as done — if retries are
 * exhausted the flow fails, surfacing an incomplete regeneration.
 */
async function triggerArticle(
  env: GlossaryRegenFlowEnv,
  itemType: ItemType,
  id: string,
): Promise<{ triggered: true }> {
  // DO naming mirrors the per-item /workflow routes: news = bare id,
  // topic/playguide = `<type>:<id>` (their id spaces would otherwise collide).
  const doName = itemType === 'news' ? id : `${itemType}:${id}`;
  const stub = env.WORKFLOW_MANAGER.get(
    env.WORKFLOW_MANAGER.idFromName(doName),
  );
  const res = await stub.fetch('http://internal/trigger', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ itemId: id, itemType }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(
      `trigger ${itemType} ${id} failed: ${res.status}${detail ? ` ${detail}` : ''}`,
    );
  }
  return { triggered: true };
}
