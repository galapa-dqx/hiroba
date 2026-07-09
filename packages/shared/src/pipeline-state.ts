/**
 * Pipeline state model — the machine-readable states each pipeline component
 * moves through, and the composite snapshot streamed over SSE for a
 * (news item | topic, language) pair.
 *
 * Components track state at their natural key:
 * - article fetch     → news_items.fetch_state / topics.fetch_state
 * - translation       → translations.state per (item_type, item_id, language, field)
 * - image mirror      → images.mirror_state (per image, language-independent)
 * - image transcribe  → images.transcribe_state (per image, language-independent)
 * - image localize    → translations.state per (image, language), fields text/url
 *
 * `pending` is mostly *derived*: a missing translations row means the work
 * hasn't been picked up yet. Rows are created when a step first touches them.
 */

export const PHASE_STATES = ['pending', 'running', 'done', 'failed'] as const;

export type PhaseState = (typeof PHASE_STATES)[number];

/** Progress of a per-image step across an item's referenced images. */
export type StepProgress = {
  done: number;
  failed: number;
  total: number;
};

/** Every image accounted for (successfully or not) — the step won't move again. */
export const isProgressSettled = (p: StepProgress): boolean =>
  p.done + p.failed >= p.total;

/**
 * Composite pipeline snapshot for one (item, language) pair. Sent verbatim as
 * SSE `state` events; the client derives display copy from it.
 */
export type StateSnapshot = {
  /** Article retrieval (scrape + parse into blocks_ja). */
  article: PhaseState;
  /** Whole-document translation (title + content rows, aggregated). */
  translation: PhaseState;
  /** Image pipeline — null for item types without one (news). */
  images: {
    /** CDN → R2 copies across every referenced image. */
    mirror: StepProgress;
    /** Vision transcription across every referenced image. */
    transcribe: StepProgress;
    /**
     * Localization progress over Japanese-text-bearing images. Null until
     * transcription settles (the candidate set isn't known before then).
     */
    localize: StepProgress | null;
  } | null;
};

/**
 * SSE wire protocol for job progress. `state` carries the article pipeline's
 * computed snapshot; `progress` is the generic channel for counter-style jobs
 * (e.g. the whole-archive scrape) that report a label + optional done/total.
 * Both terminate with `complete` (optional human summary) or `error`.
 */
export type SSEEvent =
  | { type: 'state'; snapshot: StateSnapshot }
  | { type: 'progress'; label: string; done?: number; total?: number }
  | { type: 'complete'; summary?: string }
  | { type: 'error'; error: string };

/**
 * Fold component states into one: any failure dominates, then any activity,
 * then done only when every part is done. An empty list is `done` (nothing to
 * wait on).
 */
export function aggregateStates(states: PhaseState[]): PhaseState {
  if (states.includes('failed')) return 'failed';
  if (states.includes('running')) return 'running';
  if (states.every((s) => s === 'done')) return 'done';
  return 'pending';
}

/**
 * Whether the snapshot is terminal: everything is either done or failed —
 * nothing left to wait on. Failed images don't hold the article open forever;
 * the page renders degraded instead. Mirroring is deliberately not consulted:
 * it always settles before translation does, and a mirror failure doesn't
 * block transcription (which falls back to the CDN).
 */
export function isSnapshotSettled(s: StateSnapshot): boolean {
  // A failed prerequisite is terminal: nothing downstream of a failed fetch or
  // translation can complete, so don't wait on it.
  if (s.article === 'failed' || s.translation === 'failed') return true;
  if (s.article !== 'done' || s.translation !== 'done') return false;
  if (s.images) {
    if (!isProgressSettled(s.images.transcribe)) return false;
    // Candidate set unknown (localize null) until transcription settles with
    // zero failures; a partially-failed transcribe still settles the pipeline.
    if (s.images.localize) {
      if (!isProgressSettled(s.images.localize)) return false;
    } else if (s.images.transcribe.failed === 0) {
      return false;
    }
  }
  return true;
}

/** Whether every component finished successfully (no degraded images). */
export function isSnapshotComplete(s: StateSnapshot): boolean {
  if (s.article !== 'done' || s.translation !== 'done') return false;
  if (s.images) {
    const { transcribe, localize } = s.images;
    if (transcribe.failed > 0 || transcribe.done < transcribe.total)
      return false;
    if (!localize) return false;
    if (localize.failed > 0 || localize.done < localize.total) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * Workflow run registry — the wire types for the admin tracker.
 * Rows are recorded in D1 when the WorkflowManager DO creates an instance
 * and reconciled against the Workflows engine when listed.
 * ------------------------------------------------------------------ */

/** Instance statuses as reported by the Cloudflare Workflows engine. */
export const WORKFLOW_RUN_STATUSES = [
  'queued',
  'running',
  'paused',
  'complete',
  'errored',
  'terminated',
  'unknown',
] as const;

export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

/**
 * Statuses that can still change — the reconciler keeps polling these.
 * `unknown` is terminal on purpose: it means the engine no longer knows the
 * instance (evicted/expired), so its status will never improve.
 */
export const ACTIVE_RUN_STATUSES = [
  'queued',
  'running',
  'paused',
] as const satisfies readonly WorkflowRunStatus[];

export const isRunActive = (s: WorkflowRunStatus): boolean =>
  (ACTIVE_RUN_STATUSES as readonly WorkflowRunStatus[]).includes(s);

/**
 * Pipeline states of one referenced image, in document order — the per-item
 * rows behind a run's mirror/transcribe/localize progress bars.
 */
export type ImagePipelineDetail = {
  /** The imageKey (`<host>/<path>`) identifying the canonical image row. */
  key: string;
  mirror: PhaseState;
  transcribe: PhaseState;
  /**
   * Whether the image carries Japanese text (i.e. is a localize candidate).
   * Null until transcription of this image settles.
   */
  hasText: boolean | null;
  /** Localization state — null when not (or not yet known to be) a candidate. */
  localize: PhaseState | null;
};

/** One tracked run, as served by the workflow worker's /runs endpoint. */
export type WorkflowRunEntry = {
  instanceId: string;
  itemType: 'news' | 'topic';
  itemId: string;
  titleJa: string | null;
  titleEn: string | null;
  status: WorkflowRunStatus;
  error: string | null;
  startedAt: string; // ISO-8601 UTC instant
  updatedAt: string; // ISO-8601 UTC instant
  snapshot: StateSnapshot;
  /** Per-image detail — empty for item types without an image pipeline. */
  images: ImagePipelineDetail[];
};

const counted = (label: string, p: StepProgress): string =>
  `${label} (${p.done + p.failed}/${p.total})…`;

/**
 * Human-readable progress line for a snapshot, in pipeline order. Presentation
 * lives client-side on purpose — the wire protocol stays machine-readable.
 */
export function describeSnapshot(s: StateSnapshot): string {
  if (s.article === 'failed') return 'Failed to fetch the article.';
  if (s.article !== 'done') return 'Fetching content…';
  if (s.images) {
    if (!isProgressSettled(s.images.mirror))
      return counted('Downloading images', s.images.mirror);
    if (!isProgressSettled(s.images.transcribe))
      return counted('Reading image text', s.images.transcribe);
  }
  if (s.translation === 'failed') return 'Translation failed.';
  if (s.translation !== 'done') return 'Translating…';
  if (s.images?.localize) {
    const { failed } = s.images.localize;
    if (!isProgressSettled(s.images.localize))
      return counted('Translating images', s.images.localize);
    if (failed > 0)
      return `Done — ${failed} image${failed === 1 ? '' : 's'} could not be localized.`;
  }
  return 'Finishing up…';
}
