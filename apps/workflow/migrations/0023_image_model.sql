-- DQX-45: a render becomes a first-class entity. The DQX-9 `images` table
-- (source transcription, deduped by upstream key) is renamed to `image_sources`,
-- and two new tables model renders: `images` (one row per mirrored original or
-- localized raster, latest-wins per (source, language), client-allocated UUID
-- id) and `image_files` (one row per stored R2 object, primary = the byte-exact
-- raster). `translations` returns to text only: the per-source translated spans
-- stay (item_type='image', field='text'), the `url` rows die (renders own their
-- R2 keys now).
--
-- Seeding: an original render per mirrored source (its primary file at the
-- source key), and a localized render per done `url` row (its primary file at
-- the recorded key, carrying the row's model + translated_at). Seeded primary
-- files carry NULL mime/dims/bytes until DQX-49's backfill measures them.

ALTER TABLE `images` RENAME TO `image_sources`;

CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` integer NOT NULL REFERENCES `image_sources`(`id`),
	`language` text,
	`model` text,
	`created_at` integer NOT NULL
);

CREATE INDEX `images_by_source_language` ON `images` (`source_id`, `language`, `created_at`);

CREATE TABLE `image_files` (
	`key` text PRIMARY KEY NOT NULL,
	`image_id` text NOT NULL REFERENCES `images`(`id`),
	`is_primary` integer NOT NULL,
	`mime` text,
	`width` integer,
	`height` integer,
	`bytes` integer,
	`created_at` integer NOT NULL
);

CREATE INDEX `image_files_by_image` ON `image_files` (`image_id`);

-- One original render per mirrored source (language NULL, model NULL).
INSERT INTO `images` (`id`, `source_id`, `language`, `model`, `created_at`)
	SELECT lower(hex(randomblob(16))), `id`, NULL, NULL, `updated_at`
	FROM `image_sources`
	WHERE `mirror_state` = 'done';

-- Its primary file at the source key (byte-exact original object).
INSERT INTO `image_files` (`key`, `image_id`, `is_primary`, `mime`, `width`, `height`, `bytes`, `created_at`)
	SELECT s.`key`, i.`id`, 1, NULL, NULL, NULL, NULL, i.`created_at`
	FROM `images` i
	JOIN `image_sources` s ON s.`id` = i.`source_id`
	WHERE i.`language` IS NULL AND i.`model` IS NULL;

-- One localized render per done `url` row, carrying its model + translated_at.
INSERT INTO `images` (`id`, `source_id`, `language`, `model`, `created_at`)
	SELECT lower(hex(randomblob(16))), CAST(t.`item_id` AS INTEGER), t.`language`, t.`model`, t.`translated_at`
	FROM `translations` t
	WHERE t.`item_type` = 'image' AND t.`field` = 'url' AND t.`state` = 'done';

-- Its primary file at the recorded l10n key (unique per (source, language)).
INSERT INTO `image_files` (`key`, `image_id`, `is_primary`, `mime`, `width`, `height`, `bytes`, `created_at`)
	SELECT t.`value`, i.`id`, 1, NULL, NULL, NULL, NULL, i.`created_at`
	FROM `images` i
	JOIN `translations` t
		ON t.`item_type` = 'image' AND t.`field` = 'url' AND t.`state` = 'done'
		AND CAST(t.`item_id` AS INTEGER) = i.`source_id`
		AND t.`language` = i.`language`
	WHERE i.`language` IS NOT NULL;

-- Renders now own their R2 keys — the `url` translation rows are retired.
DELETE FROM `translations` WHERE `item_type` = 'image' AND `field` = 'url';
