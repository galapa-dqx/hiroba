/**
 * Pipeline state model — the machine-readable states a pipeline component moves
 * through. Only `translations.state` is still stored, per (item_type, item_id,
 * language, field); `pending` there is mostly *derived*, since a missing row
 * means the work hasn't been picked up yet.
 *
 * The image steps carry no state columns (DQX-46). Their done-ness is the data
 * they produce — an original `images` row for the mirror, `texts_ja` for the
 * transcription, a localized `images` row for the localize — and the admin
 * panels map "produced / not produced" onto `done` / `pending` for display.
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
