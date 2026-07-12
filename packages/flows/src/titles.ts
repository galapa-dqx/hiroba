import { defineFlow, step, units } from '@hiroba/flow';

/** The item types whose titles the two flows below translate. Inlined rather
 *  than imported: definitions stay dependency-free (docs/flow-framework.md). */
type TitleItemType = 'news' | 'topic' | 'playguide';

/**
 * Eager title translation at discovery (DQX-11): read the batch's current
 * titles, load the enabled-language whitelist, and translate one chunk per
 * language per durable unit, so list pages read in the target language before
 * anyone opens the article.
 *
 * The key is the dedup OPT-OUT: every discovery batch is its own disjoint id
 * set, so two concurrent starts are never the same work — attaching one batch
 * to another's run would silently drop its ids. A random key means every start
 * creates, none attach. (The hub calls `key` once at start and stores the
 * result; randomness never crosses into the durable run.)
 */
export const TitleFlow = defineFlow({
  name: 'title',
  key: (_params: { itemType: TitleItemType; itemIds: string[] }) =>
    crypto.randomUUID(),
  steps: {
    loadTitles: step(),
    languages: step(),
    translate: units(),
  },
});

/**
 * Whole-archive title translation for one language (DQX-13): page D1 for the
 * language's untranslated titles, newest first, until every item type runs
 * dry. One segment per item type, each an indeterminate page-until-no-progress
 * loop (a translated title gains a value and leaves the scan set — there is no
 * cursor).
 *
 * Keyed by the language: the admin pre-warm and every under-translated list
 * view route through the hub, so a backfill already in flight for the language
 * is attached to, never doubled. This replaces the old `title-backfill:<lang>`
 * WorkflowManager DO instance (its `activeBackfills` map) as the dedup point.
 */
export const TitleBackfillFlow = defineFlow({
  name: 'title-backfill',
  key: (params: { language: string }) => params.language,
  steps: {
    news: units(),
    topic: units(),
    playguide: units(),
  },
});
