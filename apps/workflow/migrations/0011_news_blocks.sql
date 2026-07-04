-- DQX-9: unify news bodies onto the richtext block model.
--
-- Replace the plaintext `content_ja` with `blocks_ja` (a JSON Block[] tree),
-- mirroring `topics.blocks_ja`. A STRICT table can't DROP COLUMN in place, so we
-- rebuild it (same pattern as 0007). Only Phase-1 list metadata is carried over;
-- `blocks_ja`/`body_fetched_at` are reset so the lazy visit-triggered pipeline
-- re-fetches each body as blocks on next view — no backfill job needed.

CREATE TABLE `news_items_new` (
    `id` text PRIMARY KEY CHECK(length(`id`) = 32),
    `category` text NOT NULL CHECK(`category` IN ('news', 'event', 'update', 'maintenance')),
    `published_at` integer NOT NULL,
    `title_ja` text NOT NULL,
    `blocks_ja` text CHECK(`blocks_ja` IS NULL OR json_valid(`blocks_ja`)),
    `body_fetched_at` integer
) STRICT;

INSERT INTO `news_items_new` (`id`, `category`, `published_at`, `title_ja`, `blocks_ja`, `body_fetched_at`)
SELECT `id`, `category`, `published_at`, `title_ja`, NULL, NULL
FROM `news_items`;

DROP TABLE `news_items`;
ALTER TABLE `news_items_new` RENAME TO `news_items`;

-- Drop the now-stale plaintext news body translations; the pipeline re-translates
-- onto the block model on re-run. Title translations stay valid, so keep them —
-- deleting them would blank list titles until each item is revisited.
DELETE FROM `translations`
WHERE `item_type` = 'news' AND `field` = 'content';
