-- Playguides: rich-text /sc/public/playguide/ reference pages, stored as a JSON
-- block tree. Structurally a sibling of `topics` (see 0009), created here with
-- the full current article shape (fetch_state from 0012, recheck columns from
-- 0014) in one go, with three deliberate differences:
--   * `id` is the page slug (guide01, guide_4_2, wintrial_1), not a 32-hex id,
--     so the length-32 CHECK is replaced by a slug charset guard.
--   * `published_at` is nullable — guides are static, not dated; listing orders
--     by `sort_order` (crawl order) instead.
--   * `sort_order` gives the discovery crawl a stable ordering.
-- Localized output reuses the `translations` table (item_type='playguide').

CREATE TABLE `playguides` (
    `id` text PRIMARY KEY
        CHECK(length(`id`) BETWEEN 1 AND 64 AND `id` NOT GLOB '*[^a-z0-9_]*'),
    `sort_order` integer NOT NULL DEFAULT 0,
    `published_at` integer,
    `title_ja` text NOT NULL,
    `blocks_ja` text CHECK(`blocks_ja` IS NULL OR json_valid(`blocks_ja`)),
    `body_fetched_at` integer,
    `fetch_state` text NOT NULL DEFAULT 'pending'
        CHECK(`fetch_state` IN ('pending', 'running', 'done', 'failed')),
    `body_checked_at` integer,
    `body_changed_at` integer
) STRICT;

CREATE INDEX `playguides_sort_order_idx` ON `playguides` (`sort_order`);

-- Widen the workflow_runs item_type CHECK to admit 'playguide' runs. STRICT
-- tables can't alter a CHECK in place, so rebuild (same pattern as 0012).
CREATE TABLE `workflow_runs_new` (
    `instance_id` text PRIMARY KEY NOT NULL,
    `item_type` text NOT NULL CHECK(`item_type` IN ('news', 'topic', 'playguide')),
    `item_id` text NOT NULL,
    `status` text NOT NULL DEFAULT 'running'
        CHECK(`status` IN ('queued', 'running', 'paused', 'complete', 'errored', 'terminated', 'unknown')),
    `error` text,
    `started_at` integer NOT NULL,
    `updated_at` integer NOT NULL
) STRICT;

INSERT INTO `workflow_runs_new`
    SELECT `instance_id`, `item_type`, `item_id`, `status`, `error`, `started_at`, `updated_at`
    FROM `workflow_runs`;

DROP TABLE `workflow_runs`;
ALTER TABLE `workflow_runs_new` RENAME TO `workflow_runs`;

CREATE INDEX `workflow_runs_started_at_idx` ON `workflow_runs` (`started_at` DESC);
