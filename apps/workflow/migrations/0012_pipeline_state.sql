-- Pipeline state columns: replace implicit "done-ness" (blocks_ja IS NOT NULL,
-- row existence in translations) with explicit machine-readable states, so the
-- SSE progress stream can report running/failed per component.
--
-- States: pending | running | done | failed. "pending" is mostly derived (a
-- missing translations row = not yet picked up); rows gain a state when a
-- workflow step first touches them.

-- Article retrieval state. Backfill: an item with a fetched block tree is done.
ALTER TABLE `news_items` ADD COLUMN `fetch_state` text NOT NULL DEFAULT 'pending'
    CHECK(`fetch_state` IN ('pending', 'running', 'done', 'failed'));
UPDATE `news_items` SET `fetch_state` = 'done' WHERE `blocks_ja` IS NOT NULL;

ALTER TABLE `topics` ADD COLUMN `fetch_state` text NOT NULL DEFAULT 'pending'
    CHECK(`fetch_state` IN ('pending', 'running', 'done', 'failed'));
UPDATE `topics` SET `fetch_state` = 'done' WHERE `blocks_ja` IS NOT NULL;

-- Image mirror + transcription state. Backfill: texts_ja written = transcribed,
-- and the pipeline mirrors before transcribing, so those images are mirrored too.
ALTER TABLE `images` ADD COLUMN `mirror_state` text NOT NULL DEFAULT 'pending'
    CHECK(`mirror_state` IN ('pending', 'running', 'done', 'failed'));
ALTER TABLE `images` ADD COLUMN `transcribe_state` text NOT NULL DEFAULT 'pending'
    CHECK(`transcribe_state` IN ('pending', 'running', 'done', 'failed'));
UPDATE `images` SET `mirror_state` = 'done', `transcribe_state` = 'done' WHERE `texts_ja` IS NOT NULL;

-- Translations: add state/error/updated_at and relax value/translated_at/model
-- to nullable — a row now exists from the moment a step starts working on it,
-- not only once output lands. STRICT tables can't relax NOT NULL in place, so
-- rebuild (same pattern as 0007/0011). Every existing row is a finished
-- translation, so they backfill to done.
--
-- Invariants:
-- - done rows always carry their output (value/translated_at/model). The CHECK
--   is one-directional on purpose: a re-translation flips state to running but
--   KEEPS the previous value, so readers can stale-while-revalidate.
-- - updated_at tracks every state change (staleness detection for orphaned
--   'running' rows); translated_at still marks the last successful output.

CREATE TABLE `translations_new` (
    `item_type` text NOT NULL,
    `item_id` text NOT NULL,
    `language` text NOT NULL,
    `field` text NOT NULL,
    `state` text NOT NULL DEFAULT 'pending'
        CHECK(`state` IN ('pending', 'running', 'done', 'failed')),
    `value` text,
    `error` text,
    `translated_at` integer,
    `model` text,
    `updated_at` integer NOT NULL,
    CONSTRAINT `translations_done_has_value` CHECK(
        `state` <> 'done' OR (`value` IS NOT NULL AND `translated_at` IS NOT NULL AND `model` IS NOT NULL)
    ),
    CONSTRAINT `translations_pk` PRIMARY KEY(`item_type`, `item_id`, `language`, `field`)
) STRICT;

INSERT INTO `translations_new`
    (`item_type`, `item_id`, `language`, `field`, `state`, `value`, `error`, `translated_at`, `model`, `updated_at`)
SELECT `item_type`, `item_id`, `language`, `field`, 'done', `value`, NULL, `translated_at`, `model`, `translated_at`
FROM `translations`;

DROP TABLE `translations`;
ALTER TABLE `translations_new` RENAME TO `translations`;
