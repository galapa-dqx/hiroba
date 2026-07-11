-- Enforce at most one in-flight ArticleWorkflow run per item. Before this,
-- WorkflowManager.ensureArticleWorkflow deduped only against an in-memory map
-- on the DO, so an eviction (map lost) or a burst of concurrent triggers (a
-- page's fire-and-forget POST /trigger racing its own self-healing SSE stream)
-- could each create a fresh instance — the same item then surfaced several
-- times in the admin tracker. The DO now consults `workflow_runs` and
-- serializes the check-and-create; this partial unique index is the backstop.

-- Collapse any pre-existing active duplicates first, else the UNIQUE INDEX
-- can't be built. Keep the newest active row per (item_type, item_id) and
-- settle the rest as 'terminated' (their engine instances finish harmlessly —
-- they drive the same shared pipeline rows toward the same end state). The
-- bare `instance_id` beside MAX(`started_at`) is SQLite's documented "pick the
-- row that holds the max" behaviour, so we keep the latest-started run.
UPDATE `workflow_runs`
SET `status` = 'terminated', `updated_at` = unixepoch() * 1000
WHERE `status` IN ('queued', 'running', 'paused')
  AND `instance_id` NOT IN (
    SELECT `instance_id` FROM (
      SELECT `instance_id`, MAX(`started_at`)
      FROM `workflow_runs`
      WHERE `status` IN ('queued', 'running', 'paused')
      GROUP BY `item_type`, `item_id`
    )
  );

-- At most one active run per item. Settled rows (complete/errored/terminated/
-- unknown) are exempt, so run history and re-runs after completion are
-- unaffected — only concurrent duplicates are rejected.
CREATE UNIQUE INDEX `workflow_runs_active_item_idx`
    ON `workflow_runs` (`item_type`, `item_id`)
    WHERE `status` IN ('queued', 'running', 'paused');
