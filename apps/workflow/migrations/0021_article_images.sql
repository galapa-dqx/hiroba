-- article_images — reverse index from mirrored images to the articles whose
-- block trees embed them, maintained on every blocks_ja write. Localized
-- images are served from versioned immutable URLs, so an admin regenerate or
-- upload must purge the pages embedding the image for the new URL to reach
-- readers; this table answers "which pages". Backfilled from existing block
-- trees via the admin sync endpoint; kept current by the db write helpers.

CREATE TABLE `article_images` (
	`item_type` text NOT NULL,
	`item_id` text NOT NULL,
	`image_key` text NOT NULL,
	PRIMARY KEY (`item_type`, `item_id`, `image_key`),
	CHECK (`item_type` IN ('news', 'topic', 'playguide'))
);

CREATE INDEX `article_images_by_key` ON `article_images` (`image_key`);
