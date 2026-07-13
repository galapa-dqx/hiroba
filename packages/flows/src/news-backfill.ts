import { defineFlow, units } from '@hiroba/flow';
import type { Category } from '@hiroba/shared';

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
  // One segment per Category — the body's `f.drain(cat, …)` over CATEGORIES
  // typechecks only while these keys mirror that union exactly.
  steps: {
    news: units(),
    event: units(),
    update: units(),
    maintenance: units(),
  },
});
