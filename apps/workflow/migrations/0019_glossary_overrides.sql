-- Admin-managed glossary overrides that survive the nightly refresh.
--
-- The `glossary` table is a mirror of the upstream dqx-translation-project CSV:
-- refreshGlossary wipes it whole and reloads it every night, so anything added
-- there by hand disappears. `glossary_overrides` is never touched by that
-- refresh, and the `glossary_effective` view layers overrides on top of the
-- mirror (an override shadows the upstream row for its key). Title translation
-- reads the view, so an override sticks across every re-translation.
--
-- Seeded with カムバック → Comeback: the model was transliterating it as
-- "Kyan-back" (e.g. the 超カムバックさん応援キャンペーン event title).

CREATE TABLE `glossary_overrides` (
	`source_text` text NOT NULL,
	`target_language` text NOT NULL,
	`translated_text` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`source_text`, `target_language`)
);

CREATE VIEW `glossary_effective` AS
	SELECT `source_text`, `target_language`, `translated_text`, `updated_at`, 1 AS `is_override`
		FROM `glossary_overrides`
	UNION ALL
	SELECT g.`source_text`, g.`target_language`, g.`translated_text`, g.`updated_at`, 0 AS `is_override`
		FROM `glossary` g
		WHERE NOT EXISTS (
			SELECT 1 FROM `glossary_overrides` o
			WHERE o.`source_text` = g.`source_text`
				AND o.`target_language` = g.`target_language`
		);

INSERT INTO `glossary_overrides` (`source_text`, `target_language`, `translated_text`, `updated_at`)
VALUES ('カムバック', 'en', 'Comeback', CAST(strftime('%s', 'now') AS INTEGER) * 1000);
