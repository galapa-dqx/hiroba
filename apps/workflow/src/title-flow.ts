/**
 * The TitleFlow body — durable title translation at discovery (DQX-11, ported
 * to the flow framework in DQX-22).
 *
 * Discovery is titles-only: the hourly cron scrapes lists, upserts items, and
 * starts this flow so list pages read in the target language before anyone
 * opens the article. The heavy ArticleWorkflow (body, images, whole-document
 * translation) stays lazy — triggered on first view — and re-translates the
 * title with full context, which wins.
 *
 * Titles are read fresh from the item's table (params carry only ids), the
 * language set from the whitelist (the old workflow took it as a param; owning
 * the read here keeps every trigger surface to just ids). Then one
 * TITLE_BATCH_SIZE chunk per language per durable unit. A chunk unit that
 * throws (transport/API error) is retried by the engine; if it exhausts its
 * retries the run fails and the shell's onFailure hook resets any titles left
 * `running` back to `pending` so nothing is stuck (lists stay on JA; first
 * view or the backfill will translate them).
 *
 * DQX-13's whole-archive backfill is a sibling flow (TitleBackfillFlow) that
 * scans D1 for a language's untranslated titles rather than taking an id set,
 * but reuses this file's translateTitleChunk as its per-page unit.
 *
 * Platform-free on purpose (no cloudflare:workers import): the FlowEntrypoint
 * shell lives in title-workflow.ts, and this body runs under runFlowInline in
 * plain-node vitest.
 */

import { createDb, getEnabledLanguages, getItemTitles } from '@hiroba/db';
import type { Flow } from '@hiroba/flow';
import { type TitleFlow } from '@hiroba/flows';

import {
  TITLE_BATCH_SIZE,
  translateTitleChunk,
} from './steps/translate-titles';
import type { Env, TitleWorkflowOutput, TitleWorkflowParams } from './types';

/** Concurrent translate units in flight. Each is one LLM call; steady-state
 *  discovery batches are one chunk per language, so this only matters for the
 *  first run after a deploy — overlap a few calls, don't burst. */
const TRANSLATE_CONCURRENCY = 3;

/** The slice of the worker env the body actually touches. */
export type TitleFlowEnv = Pick<Env, 'DB' | 'GEMINI_API_KEY'>;

export async function runTitleFlow(
  f: Flow<(typeof TitleFlow)['steps']>,
  params: TitleWorkflowParams,
  env: TitleFlowEnv,
): Promise<TitleWorkflowOutput> {
  const { itemType, itemIds } = params;
  const db = createDb(env.DB);

  // Callers guard the empty case, but a run that slips through must still
  // settle its declared segments — the run decided there was nothing to do.
  if (itemIds.length === 0) {
    f.skip('loadTitles', 'no items');
    f.skip('languages', 'no items');
    f.skip('translate', 'no items');
    return { itemType, translated: 0, failed: 0 };
  }

  // Read current titles once (memoized across replays); params carry only ids.
  const items = await f.step('loadTitles', () =>
    getItemTitles(db, itemType, itemIds),
  );

  // The whitelist read is its own memoized step so every chunk translates into
  // the same language set even if the admin edits it mid-run.
  const languages = await f.step('languages', async () =>
    (await getEnabledLanguages(db)).map((l) => l.code),
  );

  const outcomes = await f.map(
    'translate',
    // Chunk boundaries derive from memoized step returns, so the unit set is
    // identical on replay and each unit id names the same chunk.
    async () => {
      const chunks: Array<{
        language: string;
        index: number;
        chunk: Array<{ id: string; titleJa: string }>;
      }> = [];
      for (const language of languages) {
        for (let i = 0; i < items.length; i += TITLE_BATCH_SIZE) {
          chunks.push({
            language,
            index: i / TITLE_BATCH_SIZE,
            chunk: items.slice(i, i + TITLE_BATCH_SIZE),
          });
        }
      }
      return chunks;
    },
    (c) =>
      translateTitleChunk(
        db,
        env.GEMINI_API_KEY,
        itemType,
        c.language,
        c.chunk,
      ),
    {
      concurrency: TRANSLATE_CONCURRENCY,
      id: (c) => `${c.language}:${c.index}`,
    },
  );

  let translated = 0;
  let failed = 0;
  for (const outcome of outcomes) {
    translated += outcome.translated;
    failed += outcome.failed;
  }
  return { itemType, translated, failed };
}
