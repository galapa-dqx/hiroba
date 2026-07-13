/**
 * Client-facing progress helpers for the item pipelines (article/playguide) —
 * how a page or panel turns a hub run into display state (DQX-28, which
 * retired the D1 `computeSnapshot` streams in favor of these).
 *
 * Three concerns, all keyed on the flow DEFINITIONS so web, admin, and the
 * workflow worker agree without importing step code:
 *   - `itemFlowStart` / `itemFlowKey` — which flow drives an item and the hub
 *     dedup key to subscribe with.
 *   - `describeItemRun` — the "simple latest-step" progress line for a live
 *     `Snapshot` (localizable via `ItemRunStrings`).
 *   - `itemRunHealth` — the settled policy over a terminal run: complete vs
 *     degraded-but-displayable vs failed, read from the run's output summary.
 */

import { renderCount, type Snapshot } from '@hiroba/flow';

import { ArticleFlow } from './article';
import { PlayguideFlow } from './playguide';

/** The body-bearing item types the article pipelines serve. */
export type ItemFlowType = 'news' | 'topic' | 'playguide';

/** The hub start arguments for one item's pipeline — playguides run their own
 *  flow keyed by slug; news/topics run the ArticleFlow keyed by type+id. */
export function itemFlowStart(
  itemType: ItemFlowType,
  itemId: string,
): { flow: string; params: unknown } {
  return itemType === 'playguide'
    ? { flow: PlayguideFlow.name, params: { slug: itemId } }
    : { flow: ArticleFlow.name, params: { itemId, itemType } };
}

/** The (flow, key) address of an item's run on the hub — what SSE and run
 *  lookups subscribe by (no run id needed; the hub resolves the latest). */
export function itemFlowKey(
  itemType: ItemFlowType,
  itemId: string,
): { flow: string; key: string } {
  return itemType === 'playguide'
    ? { flow: PlayguideFlow.name, key: PlayguideFlow.key({ slug: itemId }) }
    : {
        flow: ArticleFlow.name,
        key: ArticleFlow.key({ itemType, itemId }),
      };
}

/**
 * Presentation templates for {@link describeItemRun}. English by default (see
 * {@link DEFAULT_ITEM_RUN_STRINGS}); the web app injects a localized set so
 * the processing callout speaks the reader's language. The `{progress}` token
 * is substituted with the step's unit counter (`3/12`, or `3…` while the
 * total is still unknown).
 */
export type ItemRunStrings = {
  fetching: string;
  extractingEvents: string;
  /** `{progress}` — per-image ingest (mirror + transcribe) child runs. */
  processingImages: string;
  translating: string;
  /** `{progress}` — per-(image, language) localize child runs. */
  translatingImages: string;
  finishing: string;
};

/** Canonical English copy, and the fallback when no strings are injected. */
export const DEFAULT_ITEM_RUN_STRINGS: ItemRunStrings = {
  fetching: 'Fetching content…',
  extractingEvents: 'Extracting events…',
  processingImages: 'Processing images ({progress})…',
  translating: 'Translating…',
  translatingImages: 'Translating images ({progress})…',
  finishing: 'Finishing up…',
};

/** Which template narrates each pipeline step. Steps of both ArticleFlow and
 *  PlayguideFlow appear; a snapshot only carries the steps its flow declares. */
const STEP_STRINGS: Record<string, keyof ItemRunStrings> = {
  loadLanguages: 'fetching',
  fetchBody: 'fetching',
  extractEvents: 'extractingEvents',
  tagEvents: 'extractingEvents',
  images: 'processingImages',
  translate: 'translating',
  localizeImages: 'translatingImages',
  purge: 'finishing',
};

/**
 * The "simple latest-step" progress line for a live run: the first step (in
 * definition order) that hasn't finished names the copy, unit steps carry
 * their counter. Presentation lives client-side on purpose — the wire
 * protocol stays machine-readable.
 */
export function describeItemRun(
  snapshot: Snapshot,
  strings: ItemRunStrings = DEFAULT_ITEM_RUN_STRINGS,
): string {
  for (const key of snapshot.order) {
    const step = snapshot.steps[key];
    if (step.state === 'complete' || step.state === 'skipped') continue;
    const template = strings[STEP_STRINGS[key] ?? 'finishing'];
    return template.replace('{progress}', renderCount(step) ?? '');
  }
  return strings.finishing;
}

/* ------------------------------------------------------------------ *
 * Settled policy — explicit code over run statuses (DQX-28).
 * ------------------------------------------------------------------ */

/**
 * How a terminal item run left its article:
 *   - `complete`   — every component finished cleanly.
 *   - `degraded`   — the article and its translations landed, but some images
 *                    didn't (joinSettled tolerates them); displayable, worth
 *                    a background heal.
 *   - `fetch-failed` — the scrape parsed nothing; the run completed with the
 *                    remaining steps skipped (there is no article to show).
 *   - `failed`     — the run itself died (or the engine lost it).
 *   - `active`     — not terminal yet.
 */
export type ItemRunHealth =
  | 'complete'
  | 'degraded'
  | 'fetch-failed'
  | 'failed'
  | 'active';

/** The slice of a hub `RunInfo` (or a terminal `Snapshot`) the health
 *  verdict reads. */
export type ItemRunLike = {
  status: string;
  output?: unknown;
};

/** The output summary shape the item flow bodies return (typed fully in
 *  apps/workflow); read defensively — output is best-effort wire data. */
type ItemRunOutput = {
  fetchBody?: { success?: boolean };
  translate?: { success?: boolean };
  localize?: { failed?: number };
};

/**
 * Fold a run's terminal status + output summary into the settled policy: a
 * completed run is only as healthy as its output says. A missing or
 * unreadable output reads as `complete` — content presence in D1 is the
 * caller's ground truth for whether there is anything to show; this verdict
 * only grades HOW it settled (cache TTL, background heal).
 */
export function itemRunHealth(run: ItemRunLike): ItemRunHealth {
  if (run.status === 'queued' || run.status === 'running') return 'active';
  if (run.status !== 'complete') return 'failed';
  const output = (run.output ?? {}) as ItemRunOutput;
  if (output.fetchBody?.success === false) return 'fetch-failed';
  if (output.translate?.success === false) return 'failed';
  if ((output.localize?.failed ?? 0) > 0) return 'degraded';
  return 'complete';
}
