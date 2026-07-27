-- DQX-46: the last two pipeline-state columns on image_sources die, now that
-- the DQX-45 render model has soaked. Both were only ever read to answer a
-- question the data already answers:
--
--   mirrored?     an original `images` row exists (language IS NULL), and its
--                 primary `image_files` key is the bytes we serve.
--   transcribed?  `texts_ja` is non-NULL ([] = transcribed, no text).
--
-- In-flight and failure are the flow run's business (hub keyed dedup + run
-- errors), not a column — the same trade migration 0022 made for fetch_state.

ALTER TABLE `image_sources` DROP COLUMN `mirror_state`;
ALTER TABLE `image_sources` DROP COLUMN `transcribe_state`;
