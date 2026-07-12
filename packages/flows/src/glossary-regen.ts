import { defineFlow, step, units } from '@hiroba/flow';

/**
 * Refresh everything affected by a changed glossary term: re-run every article
 * whose Japanese body quotes it and refresh the stored `text` translation of
 * every image whose baked-in Japanese contains it. The affected set can be huge
 * (a common term appears in hundreds of bodies), so both scans are keyset-paged
 * — indeterminate unit totals, driven through the `open` handle because page
 * N+1 needs page N's cursor.
 *
 * Keyed by the term: re-triggering a term whose regeneration is still running
 * attaches to the run in flight instead of starting a duplicate. This replaces
 * the old per-term WorkflowManager DO (`regen:<term>` storage key +
 * blockConcurrencyWhile) as the dedup point.
 */
export const GlossaryRegenFlow = defineFlow({
  name: 'glossary-regen',
  key: (params: { sourceText: string }) => params.sourceText,
  steps: {
    scanArticles: units(),
    retriggerArticles: units(),
    languages: step(),
    retranslateImages: units(),
  },
});
