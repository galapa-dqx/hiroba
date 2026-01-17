-- Remove lock columns now that concurrency is handled by Durable Objects

-- SQLite doesn't support DROP COLUMN directly, so we need to recreate tables

-- Recreate news_items without body_fetching_since
CREATE TABLE `news_items_new` (
	`id` text PRIMARY KEY,
	`title_ja` text NOT NULL,
	`category` text NOT NULL,
	`published_at` integer NOT NULL,
	`content_ja` text,
	`body_fetched_at` integer
);

INSERT INTO `news_items_new` (`id`, `title_ja`, `category`, `published_at`, `content_ja`, `body_fetched_at`)
SELECT `id`, `title_ja`, `category`, `published_at`, `content_ja`, `body_fetched_at`
FROM `news_items`;

DROP TABLE `news_items`;
ALTER TABLE `news_items_new` RENAME TO `news_items`;

-- Recreate translations without translating_since
CREATE TABLE `translations_new` (
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`language` text NOT NULL,
	`field` text NOT NULL,
	`value` text NOT NULL,
	`translated_at` integer NOT NULL,
	`model` text,
	CONSTRAINT `translations_new_pk` PRIMARY KEY(`item_type`, `item_id`, `language`, `field`)
);

INSERT INTO `translations_new` (`item_type`, `item_id`, `language`, `field`, `value`, `translated_at`, `model`)
SELECT `item_type`, `item_id`, `language`, `field`, `value`, `translated_at`, `model`
FROM `translations`;

DROP TABLE `translations`;
ALTER TABLE `translations_new` RENAME TO `translations`;
