/**
 * Workflow runs table — the registry behind the admin workflow tracker.
 *
 * One row per ArticleWorkflow instance, inserted by the WorkflowManager DO
 * when it creates the instance. The Workflows engine itself has no listing
 * API from a binding (only get-by-id), so this table is what makes in-flight
 * runs enumerable. `status` mirrors instance.status() and is reconciled
 * lazily whenever runs are listed; per-step progress is NOT stored here — it
 * is computed from the pipeline-state columns (the D1 ground truth).
 */

import { sql } from 'drizzle-orm';
import { check, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import type { WorkflowRunStatus } from '@hiroba/shared';

import { instant } from '../types/instant';

export const workflowRuns = sqliteTable(
  'workflow_runs',
  {
    // The Cloudflare Workflows instance id.
    instanceId: text('instance_id').primaryKey(),

    itemType: text('item_type').$type<'news' | 'topic'>().notNull(),
    itemId: text('item_id').notNull(),

    // Last-seen engine status; error carries instance.status().error when set.
    status: text('status')
      .$type<WorkflowRunStatus>()
      .notNull()
      .default('running'),
    error: text('error'),

    startedAt: instant('started_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    check(
      'workflow_runs_item_type_valid',
      sql`${table.itemType} IN ('news', 'topic')`,
    ),
    check(
      'workflow_runs_status_valid',
      sql`${table.status} IN ('queued', 'running', 'paused', 'complete', 'errored', 'terminated', 'unknown')`,
    ),
  ],
);

export type WorkflowRun = typeof workflowRuns.$inferSelect;
export type NewWorkflowRun = typeof workflowRuns.$inferInsert;
