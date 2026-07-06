-- Workflow run registry: one row per ArticleWorkflow instance, written by the
-- WorkflowManager DO at trigger time. The Workflows binding can only fetch
-- instances by id — this table is what lets the admin tracker enumerate
-- in-flight (and recently settled) runs. `status` mirrors the engine's
-- instance.status() and is reconciled lazily on listing; per-step progress
-- stays in the pipeline-state columns (0012), not here.

CREATE TABLE `workflow_runs` (
    `instance_id` text PRIMARY KEY NOT NULL,
    `item_type` text NOT NULL CHECK(`item_type` IN ('news', 'topic')),
    `item_id` text NOT NULL,
    `status` text NOT NULL DEFAULT 'running'
        CHECK(`status` IN ('queued', 'running', 'paused', 'complete', 'errored', 'terminated', 'unknown')),
    `error` text,
    `started_at` integer NOT NULL,
    `updated_at` integer NOT NULL
) STRICT;

CREATE INDEX `workflow_runs_started_at_idx` ON `workflow_runs` (`started_at` DESC);
