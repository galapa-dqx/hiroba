-- event_sources: provenance join between canonical events and the articles that
-- mention them (many-to-many). Event identity moved off the source-scoped hash
-- (0005/0008) to allocated ids matched on re-extraction, so one campaign named
-- in a roundup AND on its own dedicated page is a single `events` row linked
-- from both articles here.
--
--   * (event_id, source_type, source_id) is the natural key — one link per
--     (event, article). event_id first so the PK also serves link lookups and
--     orphan GC by event.
--   * A reverse index (source_type, source_id) powers "events in this article"
--     and the per-source re-extraction that swaps only that source's links.
--   * No DB-level FK — consistent with the rest of the schema (events.source_id
--     is likewise an un-enforced reference); orphaned events are swept in code.
--   * Schedule events (source_type='schedule') never appear here: they're
--     deterministic and replaced wholesale, so they keep using
--     events.source_id directly.

CREATE TABLE `event_sources` (
    `event_id` text NOT NULL,
    `source_type` text NOT NULL CHECK(`source_type` IN ('news', 'topic')),
    `source_id` text NOT NULL,
    `created_at` integer NOT NULL,
    PRIMARY KEY (`event_id`, `source_type`, `source_id`)
) STRICT;

CREATE INDEX `event_sources_by_source` ON `event_sources` (`source_type`, `source_id`);
