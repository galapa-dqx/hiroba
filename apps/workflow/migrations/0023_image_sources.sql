-- image_sources — one row per stored R2 image object, grouped by the primary
-- (fallback) object's key. The primary row has key = group_key; the rest are
-- variants of the same raster — alternate encodings (AVIF) and/or resized
-- fit-inside renditions, distinguished by mime + dimensions — fed into the
-- web renderer's <picture> tag alongside the primary's width/height.
--
-- Existing pointers double as group lookups: `images.key` (mirrored
-- originals) and the value of an image's `url` translation row (localized
-- renders) both name the primary object. No sentinel columns: a group's rows
-- are written complete-at-birth (variants encoded, then the whole row set
-- inserted in one call), so the presence of the primary row is the
-- "attempted" marker — and the web renders only recorded rows, so a render
-- whose rows haven't landed yet just serves as a bare <img>. A regeneration
-- mints a new versioned key = a new group; the old group's rows orphan
-- alongside the old objects (and this table doubles as the bucket inventory
-- a future orphan prune would walk).
CREATE TABLE image_sources (
  key TEXT PRIMARY KEY,        -- R2 object key of this variant
  group_key TEXT NOT NULL,     -- the primary object's key (primary row: key = group_key)
  mime TEXT NOT NULL,          -- content type of the stored bytes
  width INTEGER,               -- pixel dimensions; NULL when unmeasurable (e.g. SVG)
  height INTEGER,
  bytes INTEGER,               -- object size, for ops/inventory queries
  created_at INTEGER NOT NULL
);

CREATE INDEX image_sources_by_group ON image_sources (group_key);
