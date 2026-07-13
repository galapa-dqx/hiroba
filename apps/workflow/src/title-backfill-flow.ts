/**
 * The TitleBackfillFlow body — whole-archive title translation for one
 * language (DQX-13, ported to the flow framework in DQX-22).
 *
 * DQX-11's TitleFlow keeps *newly discovered* titles translated; this fills
 * the existing archive (all news categories + the ~168 months of topics
 * backnumbers) the first time a language needs it. It is fired lazily — the
 * first list view in an under-translated language kicks it off — and can be
 * pre-warmed from the admin before a language is announced. Both routes go
 * through hub.start keyed on the language, so a run in flight is attached to,
 * never doubled.
 *
 * The flow owns the scan: params carry only the language, and each item type
 * is paged newest-first through getUntranslatedTitles, one durable unit per
 * page so engine checkpointing gives resume-on-failure for free. Each page is
 * translated by the same glossary-aware translateTitleChunk the discovery flow
 * uses. It is idempotent — already-translated titles have a value and drop out
 * of the scan, so a re-run only touches what's still missing, which is also
 * what makes it safe as a self-healing retry when the hourly cron's title
 * batch (DQX-11) drops something.
 *
 * There is no cursor: a translated title gains a value and leaves the scan
 * set, so the next scan returns the next-newest untranslated page. Driven
 * through the `open` handle because of exactly that — page N+1's content
 * depends on page N having translated, so map/drain (where the pool owns the
 * counter) don't apply. A page that translates nothing (every id dropped by
 * the model) would otherwise repeat forever, so the loop stops the moment a
 * page makes no forward progress — those stragglers stay on their JA fallback
 * for a later run or first view.
 *
 * On terminal failure (a page exhausted its retries) the shell's onFailure
 * hook resets any titles left `running` for this language back to `pending`,
 * so nothing is stuck; lists stay on the JA fallback and the next run (or
 * first view) picks them up.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in title-backfill-workflow.ts, and this body runs under
 * runFlowInline in plain-node vitest.
 */

import { createDb, getUntranslatedTitles } from '@hiroba/db';
import type { Flow, FlowLogger } from '@hiroba/flow';
import { type TitleBackfillFlow } from '@hiroba/flows';

import { translateTitleChunk } from './steps/translate-titles';
import type {
  Env,
  ItemType,
  TitleBackfillWorkflowOutput,
  TitleBackfillWorkflowParams,
} from './types';

/**
 * Titles per backfill page = per LLM call = per durable unit. Larger than the
 * discovery batch (titles are short, so this is well within a request): fewer
 * units to page a multi-thousand-title archive, still small enough to bound a
 * retried unit and the blast radius of one dropped response.
 */
export const TITLE_BACKFILL_BATCH_SIZE = 100;

/** One declared segment per item type — the def's step keys ARE the scan
 *  order. */
const ITEM_TYPES: readonly ItemType[] = ['news', 'topic', 'playguide'];

/** The slice of the worker env the body actually touches. */
export type TitleBackfillFlowEnv = Pick<Env, 'DB' | 'GEMINI_API_KEY'>;

export async function runTitleBackfillFlow(
  f: Flow<(typeof TitleBackfillFlow)['steps']>,
  params: TitleBackfillWorkflowParams,
  env: TitleBackfillFlowEnv,
  log: FlowLogger,
): Promise<TitleBackfillWorkflowOutput> {
  const { language } = params;
  const db = createDb(env.DB);

  // Closure-accumulated across engine units — replay-safe for the same reason
  // as GlossaryRegenFlow's affected list: every addition comes from a memoized
  // unit return, so a replay rebuilds the counts without re-running anything.
  let scanned = 0;
  let translated = 0;
  let failed = 0;

  for (const itemType of ITEM_TYPES) {
    const sweep = f.open(itemType);
    await sweep.expect(null);
    for (let page = 0; ; page++) {
      const batch = await sweep.unit(`scan-${page}`, () =>
        getUntranslatedTitles(
          db,
          itemType,
          language,
          TITLE_BACKFILL_BATCH_SIZE,
        ),
      );
      if (batch.length === 0) break;

      scanned += batch.length;
      const outcome = await sweep.unit(`translate-${page}`, () =>
        translateTitleChunk(db, env.GEMINI_API_KEY, itemType, language, batch),
      );
      translated += outcome.translated;
      failed += outcome.failed;

      // No title advanced — every id in this page was dropped by the model.
      // The scan set won't shrink, so stop rather than re-page it forever.
      if (outcome.translated === 0) {
        log.warn(
          `title-backfill:${language} ${itemType}: no progress on ${batch.length} title(s); stopping`,
        );
        break;
      }
    }
    await sweep.done();
  }

  return { language, scanned, translated, failed };
}
