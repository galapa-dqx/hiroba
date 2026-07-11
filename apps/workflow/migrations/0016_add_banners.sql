-- Rotation banners: the promotional carousel scraped from
-- https://hiroba.dqx.jp/sc/rotationbanner and shown on the home page.
--
-- The banner IMAGE is a row in the shared `images` table (keyed by image_key),
-- so it mirrors/transcribes/localizes through the existing pipeline and its
-- translated variant serves from l10n/<lang>/<key> like any article image.
-- This table only holds banner metadata: link, caption, rotation order, and
-- whether it's currently in rotation (stale banners are deactivated, not
-- deleted, so their localized images stay cached for a re-appearance).

CREATE TABLE `banners` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`image_key` text NOT NULL,
	`link_url` text,
	`link_topic_id` text,
	`alt_ja` text NOT NULL,
	`sort_order` integer NOT NULL,
	`published_at` integer,
	`active` integer NOT NULL DEFAULT 1,
	`updated_at` integer NOT NULL,
	CONSTRAINT `banners_link_topic_id_len`
		CHECK (`link_topic_id` IS NULL OR length(`link_topic_id`) = 32)
);

CREATE UNIQUE INDEX `banners_image_key_unique` ON `banners` (`image_key`);
CREATE INDEX `banners_active_order_idx` ON `banners` (`active`, `sort_order`);
