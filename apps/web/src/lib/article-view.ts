/**
 * The article pages' render gate — the "settled" policy as explicit code over
 * hub run statuses (DQX-28, replacing the D1 `computeSnapshot` fold).
 *
 * Two inputs decide everything: whether translated content EXISTS in D1 for
 * the viewer's language (the ground truth for "is there anything to show"),
 * and the item's latest hub run (the ground truth for "is anything still
 * moving / how did the last attempt settle"). Degraded images never hold a
 * page hostage — joinSettled already tolerated them in the run, and here a
 * degraded settle still displays, just with a short cache so the background
 * heal surfaces on its own.
 */

// Type-only: the /hub entry's runtime half imports cloudflare:workers.
import type { RunInfo } from '@hiroba/flow/hub';
import { itemRunHealth } from '@hiroba/flows';

import {
  CACHE_ARTICLE_COMPLETE,
  CACHE_ARTICLE_DEGRADED,
  CACHE_NONE,
} from './cache';

export type ArticlePhase =
  /** Everything landed cleanly (or the run is long pruned) — cache hard. */
  | 'ready-complete'
  /** Displayable, but the last run left failures — short cache + heal. */
  | 'ready-degraded'
  /** A run is (or should be) driving the item — callout + live progress. */
  | 'processing'
  /** The scrape found no article body; nothing to show until a retry. */
  | 'fetch-failed'
  /** The body landed but translation didn't; nothing to show until a retry. */
  | 'translate-failed'
  /** The last run died without producing this language's content. */
  | 'run-failed';

export type ArticleView = {
  phase: ArticlePhase;
  /** Whether the body renders (vs the processing/error callout). */
  ready: boolean;
  cacheControl: string;
  /** How the page should (re)arm the pipeline: `force` bypasses the cooldown
   *  (a viewer is waiting on missing content), `cooldown` is the throttled
   *  background heal, null leaves a healthy item alone. */
  trigger: 'force' | 'cooldown' | null;
  /** Set when `processing` was decided over an ALREADY-TERMINAL run (one that
   *  ran before this language existed): the client must not treat this run's
   *  replayed terminal frame as fresh completion, or it reload-loops until
   *  the newly-forced run wins the flow-key stream. */
  staleRunId?: string;
};

/**
 * Fold content presence + the latest hub run into the page's render decision.
 *
 * `hasContent` = the viewer's language has a translated title AND body. A
 * missing run on a content-bearing item is the normal long-settled case (the
 * hub prunes runs after a week); a missing run on an empty item means the
 * pipeline never ran — start it and watch.
 */
export function resolveArticleView(
  hasContent: boolean,
  run: RunInfo | null,
): ArticleView {
  const health = run ? itemRunHealth(run) : null;

  if (health === 'active') {
    return {
      phase: 'processing',
      ready: false,
      cacheControl: CACHE_NONE,
      trigger: null,
    };
  }

  if (hasContent) {
    // Terminal or no run at all: the content is what it is. Grade the settle
    // for cache TTL + whether a background heal is worth arming.
    const complete = health === null || health === 'complete';
    return {
      phase: complete ? 'ready-complete' : 'ready-degraded',
      ready: true,
      cacheControl: complete ? CACHE_ARTICLE_COMPLETE : CACHE_ARTICLE_DEGRADED,
      trigger: complete ? null : 'cooldown',
    };
  }

  // No content for this language yet.
  if (
    health === 'fetch-failed' ||
    health === 'translate-failed' ||
    health === 'failed'
  ) {
    // The last attempt is a known dead end — retry on the cooldown so page
    // views during an outage don't hammer the pipeline.
    return {
      phase:
        health === 'fetch-failed'
          ? 'fetch-failed'
          : health === 'translate-failed'
            ? 'translate-failed'
            : 'run-failed',
      ready: false,
      cacheControl: CACHE_NONE,
      trigger: 'cooldown',
    };
  }

  // Never ran, or ran before this language existed (a complete/degraded run
  // with no content for the viewer's language): a viewer is waiting — start
  // (or attach to) a run past the cooldown and follow it live. The old run's
  // terminal frame will replay on the flow-key stream — mark it stale.
  return {
    phase: 'processing',
    ready: false,
    cacheControl: CACHE_NONE,
    trigger: 'force',
    ...(run ? { staleRunId: run.runId } : null),
  };
}
