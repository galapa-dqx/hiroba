-- DQX-28: the per-item fetch_state column dies with computeSnapshot, its only
-- reader. The scrape's success/failure now travels in the article run's
-- output summary on the FlowHub (fetchBody.success), and the web render gate
-- reads run status + content presence instead of D1 state columns. The other
-- pipeline state columns stay: translations.state serves content reads, and
-- images.mirror_state / images.transcribe_state feed the admin image panels.

ALTER TABLE `news_items` DROP COLUMN `fetch_state`;
ALTER TABLE `topics` DROP COLUMN `fetch_state`;
ALTER TABLE `playguides` DROP COLUMN `fetch_state`;
