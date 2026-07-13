/**
 * Pipeline state model — the machine-readable states individual pipeline
 * components move through, tracked at their natural key:
 * - translation       → translations.state per (item_type, item_id, language, field)
 * - image mirror      → images.mirror_state (per image, language-independent)
 * - image transcribe  → images.transcribe_state (per image, language-independent)
 * - image localize    → translations.state per (image, language), fields text/url
 *
 * `pending` is mostly *derived*: a missing translations row means the work
 * hasn't been picked up yet. Rows are created when a step first touches them.
 *
 * (The composite per-item `StateSnapshot` and its SSE stream retired with
 * DQX-28 — cross-step progress is the item's hub run now; see
 * @hiroba/flows' progress module.)
 */

export const PHASE_STATES = ['pending', 'running', 'done', 'failed'] as const;

export type PhaseState = (typeof PHASE_STATES)[number];

/**
 * Domain enrichment attached to an article/playguide flow run by the workflow
 * worker's /flow/runs listing: which item the run is about, and its titles.
 */
export type FlowRunItem = {
  itemType: 'news' | 'topic' | 'playguide';
  itemId: string;
  titleJa: string | null;
  titleEn: string | null;
};
