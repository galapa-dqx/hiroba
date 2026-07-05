/**
 * Pipeline snapshot — computes the composite StateSnapshot for one
 * (item, language) pair from D1 ground truth.
 *
 * This is the readiness predicate behind the SSE stream *and* the page-render
 * gate (the web app holds an article back until its images are localized). It
 * reads persisted state rather than any single workflow instance's output on
 * purpose: image rows are shared across topics, so progress can be advanced by
 * a *different* topic's workflow — or already be done with nothing running.
 */

import { collectImages, imageKey, type Block } from '@hiroba/richtext';
import {
  aggregateStates,
  hasJapanese,
  type PhaseState,
  type StateSnapshot,
  type StepProgress,
} from '@hiroba/shared';

import type { Database } from './client';
import {
  getImagesByKeys,
  getImageTranslationStates,
  getNewsItem,
  getTopic,
  getTranslationStates,
} from './queries';

/** The translated fields every article needs (news and topics alike). */
const ARTICLE_FIELDS = ['title', 'content'] as const;

const tally = (states: PhaseState[], total: number): StepProgress => ({
  done: states.filter((s) => s === 'done').length,
  failed: states.filter((s) => s === 'failed').length,
  total,
});

async function imagesSnapshot(
  db: Database,
  blocks: Block[] | null,
  language: string,
): Promise<NonNullable<StateSnapshot['images']>> {
  // Until the body is fetched, the referenced-image set is unknown; the
  // zero-total placeholders never gate anything because the article itself is
  // still pending.
  const none: StepProgress = { done: 0, failed: 0, total: 0 };
  if (!blocks) return { mirror: none, transcribe: none, localize: null };

  const keys = [
    ...new Set(
      collectImages(blocks)
        .map((i) => imageKey(i.src))
        .filter((k): k is string => !!k),
    ),
  ];
  if (keys.length === 0)
    return { mirror: none, transcribe: none, localize: none };

  // Keys with no row yet haven't been discovered by the mirror step — they
  // count toward the totals as (implicitly pending) undone work.
  const rows = await getImagesByKeys(db, keys);
  const mirror = tally(
    rows.map((r) => r.mirrorState),
    keys.length,
  );
  const transcribe = tally(
    rows.map((r) => r.transcribeState),
    keys.length,
  );

  // The localize candidate set (Japanese-text-bearing images) isn't known
  // until every referenced image has been transcribed or given up on.
  if (transcribe.done + transcribe.failed < transcribe.total)
    return { mirror, transcribe, localize: null };

  const candidates = rows.filter((r) => r.textsJa && hasJapanese(r.textsJa));
  const urlStates = await getImageTranslationStates(
    db,
    candidates.map((r) => r.id),
    language,
    'url',
  );
  const localize = tally(
    candidates.map((r) => urlStates.get(r.id) ?? 'pending'),
    candidates.length,
  );
  return { mirror, transcribe, localize };
}

/**
 * Compute the pipeline snapshot for an item in a language. Works with no
 * workflow running — an untouched item reports everything `pending`, a
 * finished one reports everything `done`.
 */
export async function computeSnapshot(
  db: Database,
  itemType: 'news' | 'topic',
  itemId: string,
  language: string,
): Promise<StateSnapshot> {
  const item =
    itemType === 'topic'
      ? await getTopic(db, itemId)
      : await getNewsItem(db, itemId);

  const article: PhaseState = item?.fetchState ?? 'pending';

  const fieldStates = await getTranslationStates(
    db,
    itemType,
    itemId,
    language,
    [...ARTICLE_FIELDS],
  );
  const translation = aggregateStates([...fieldStates.values()]);

  // Only the topics pipeline has image steps.
  const images =
    itemType === 'topic'
      ? await imagesSnapshot(
          db,
          (item?.blocksJa ?? null) as Block[] | null,
          language,
        )
      : null;

  return { article, translation, images };
}
