-- Language whitelist: the admin-managed list of translation target languages.
-- The pipeline translates into each enabled language; the web app serves a
-- /<code>/ route tree per enabled language. Japanese is the source language,
-- so it never appears here.
--
--   label        — English name ("French"), interpolated into LLM prompts
--   native_label — endonym ("Français"), shown in the web language selector
--
-- Seeded with English, the only target before this table existed.

CREATE TABLE `languages` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`native_label` text NOT NULL,
	`enabled` integer NOT NULL DEFAULT 1,
	`updated_at` integer NOT NULL
);

INSERT INTO `languages` (`code`, `label`, `native_label`, `enabled`, `updated_at`)
VALUES ('en', 'English', 'English', 1, CAST(strftime('%s', 'now') AS INTEGER) * 1000);
