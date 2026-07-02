-- Topics: rich-text /topics/detail/ content, stored as a JSON block tree.
-- Mirrors news_items, but the body is a structured block tree (blocks_ja) rather
-- than plaintext. Localized output (title + content block tree) reuses the
-- existing `translations` table (item_type='topic', field='title'|'content'),
-- so there is no blocks_en column and no translation_memory table.

CREATE TABLE `topics` (
    `id` text PRIMARY KEY CHECK(length(`id`) = 32),
    `published_at` integer NOT NULL,
    `title_ja` text NOT NULL,
    `blocks_ja` text CHECK(`blocks_ja` IS NULL OR json_valid(`blocks_ja`)),
    `category` text,
    `body_fetched_at` integer
) STRICT;

CREATE INDEX `topics_published_at_idx` ON `topics` (`published_at`);
