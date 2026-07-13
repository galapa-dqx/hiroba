import { defineFlow } from '@hiroba/flow';

import { articleImagework, articleIntake, articleOutput } from './fragments';

/**
 * The playguide pipeline (DQX-24) — playguides split out of the old
 * ArticleWorkflow as their own flow. The step shape is pure fragment
 * composition: intake → per-image ingest → translate/localize/purge. No event
 * steps are declared at all — playguides are static reference pages with no
 * dated events, so there is nothing to skip (the branch the old unified
 * workflow carried disappears from the shape itself).
 *
 * Keyed by the guide's slug: every trigger surface (admin re-run, web first
 * view, recheck heal) routes through the hub, so a run already in flight for
 * the slug is attached to, never doubled — this replaces the old
 * `playguide:<slug>` coordinator DO instance as the dedup point.
 */
export const PlayguideFlow = defineFlow({
  name: 'playguide',
  key: (params: { slug: string }) => params.slug,
  steps: {
    ...articleIntake,
    ...articleImagework,
    ...articleOutput,
  },
});
