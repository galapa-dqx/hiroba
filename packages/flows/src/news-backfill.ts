import { defineFlow, unitsForEach } from '@hiroba/flow';
import { CATEGORIES, type Category } from '@hiroba/shared';

/**
 * Whole-archive news list scrape: page every requested category's archive
 * until an empty page (the `drain` pool — pagination is page numbers, so the
 * pool owns the counter and emptiness is monotonic on these endpoints). One
 * indeterminate `units` segment per category, one page per unit; a run scoped
 * to a single category stores a skip on the other three.
 *
 * Keyed by the requested scope (`category ?? 'all'`), replacing the old
 * `scrape:news:<category|all>` WorkflowManager DO-name convention as the dedup
 * point: re-triggering a scope still in flight attaches to the running scrape.
 */
export const NewsBackfillFlow = defineFlow({
  name: 'news-backfill',
  key: (params: { category?: Category }) => params.category ?? 'all',
  // One segment per Category, derived from the list itself so the declared
  // shape can't drift from the domain in either direction.
  steps: unitsForEach(CATEGORIES),
});

/**
 * The run's terminal output. Declared beside the definition so producer
 * (apps/workflow's flow body) and consumers (the admin's completion toast)
 * derive from one shape — admin can't import the workflow app's types.
 */
export type NewsBackfillOutput = {
  /** List pages that carried items. */
  pages: number;
  /** List ROWS scanned — a raw work counter, not a distinct-item count: when
   *  the newest-first archive shifts mid-run, the same item can appear on two
   *  scanned pages and is counted each time. */
  scraped: number;
  /** Items actually inserted. Distinct by construction — the upsert's
   *  conflict resolution decides, atomically, regardless of page overlap. */
  newItems: number;
};
