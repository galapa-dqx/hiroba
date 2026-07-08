-- Recheck tracking: articles are re-polled for edits after publication on a
-- fading schedule anchored to the last observed content change (see
-- packages/shared/src/freshness.ts).
--
--   body_checked_at — last time the source page was polled (change or not)
--   body_changed_at — last time the polled content actually differed; NULL
--                     means never seen to change, so the schedule anchors on
--                     published_at instead
--
-- Backfill: the initial body fetch counts as the first check.

ALTER TABLE `news_items` ADD COLUMN `body_checked_at` integer;
ALTER TABLE `news_items` ADD COLUMN `body_changed_at` integer;
UPDATE `news_items` SET `body_checked_at` = `body_fetched_at` WHERE `body_fetched_at` IS NOT NULL;

ALTER TABLE `topics` ADD COLUMN `body_checked_at` integer;
ALTER TABLE `topics` ADD COLUMN `body_changed_at` integer;
UPDATE `topics` SET `body_checked_at` = `body_fetched_at` WHERE `body_fetched_at` IS NOT NULL;
