-- Images: canonical per-image record, deduped across topics. Surrogate id (so
-- translations.item_id stays short/uniform), with the imageKey (<host>/<path>)
-- as the natural unique key. Holds the JA transcription (source of truth):
-- texts_ja is every transcribed span (NULL = not transcribed, [] = no text).
-- Whether an image is worth localizing ("has >=1 Japanese span") is derived from
-- texts_ja at the point of use, not stored.
--
-- EN outputs reuse the `translations` table with item_type='image',
-- item_id=images.id, field='text' (translated spans) | 'url' (localized R2 key).
-- No CHECK on translations.item_type/field, so that needs no migration.

CREATE TABLE `images` (
    `id` integer PRIMARY KEY AUTOINCREMENT,
    `key` text NOT NULL UNIQUE,
    `texts_ja` text CHECK(`texts_ja` IS NULL OR json_valid(`texts_ja`)),
    `transcribe_model` text,
    `updated_at` integer NOT NULL
) STRICT;
