import { defineFlow, step } from '@hiroba/flow';

import { articleImagework, articleIntake, articleOutput } from './fragments';

/**
 * The article pipeline (DQX-25) — news items and topics, the highest-volume
 * flow. The step shape is the playguide composition PLUS the two event steps
 * (calendar-event extraction and inline time/event tagging) between intake and
 * imagework: ArticleFlow ⊃ PlayguideFlow, which is exactly what lets both hand
 * their trackers to the shared body helpers in apps/workflow.
 *
 * Keyed `${itemType}:${itemId}` — the one-run-per-item dedup that used to live
 * in the old per-item coordinator DO's name (news = bare id, topic = prefixed).
 * Every trigger surface (web first view, admin re-run, recheck heal, glossary
 * regen fan-out, self-healing SSE) routes through the hub, so a run already in
 * flight for the item is attached to, never doubled.
 */
export const ArticleFlow = defineFlow({
  name: 'article',
  key: (params: { itemType: 'news' | 'topic'; itemId: string }) =>
    `${params.itemType}:${params.itemId}`,
  steps: {
    ...articleIntake,
    extractEvents: step(),
    tagEvents: step(),
    ...articleImagework,
    ...articleOutput,
  },
});
