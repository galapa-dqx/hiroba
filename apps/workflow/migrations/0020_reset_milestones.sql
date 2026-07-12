-- Admin-managed recurring "content reset" definitions.
--
-- DQX resets content on server-side cronjobs (daily 06:00 JST, weekly Sunday,
-- semi-monthly, monthly — https://ethene.wiki/wiki/Reset_Times). Nothing on
-- hiroba.dqx.jp announces them, so they can't be scraped; the admin curates them
-- here. Each row is an iCal RRULE (RFC 5545, incl. its DTSTART line, anchored in
-- Asia/Tokyo) plus an inline per-language name. A nightly task materializes the
-- next horizon of occurrences into `events` as type='mark', source_type='reset'
-- rows (see reset-events.ts), so the calendar renders them as milestones.

CREATE TABLE `reset_milestones` (
	`id` text PRIMARY KEY,
	`title_ja` text NOT NULL,
	`titles` text NOT NULL,
	`rrule` text NOT NULL,
	`enabled` integer NOT NULL DEFAULT 1,
	`sort_order` integer NOT NULL DEFAULT 0,
	`note` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CHECK (json_valid(`titles`))
);

-- Seed the canonical DQX resets. All fire at 06:00 JST; the DTSTART anchor date
-- is chosen to satisfy each rule's BYDAY/BYMONTHDAY (2020-01-05 is a Sunday).
INSERT INTO `reset_milestones`
	(`id`, `title_ja`, `titles`, `rrule`, `sort_order`, `note`, `created_at`, `updated_at`)
VALUES
	(
		'daily',
		'デイリーリセット',
		'{"en":"Daily reset","ja":"デイリーリセット"}',
		'DTSTART;TZID=Asia/Tokyo:20200101T060000' || char(10) || 'RRULE:FREQ=DAILY',
		0,
		'Book of Bosses, daily subjugation, Magic Maze, Coliseum, crafting/fishing/housing, quest & team replay, etc.',
		CAST(strftime('%s', 'now') AS INTEGER) * 1000,
		CAST(strftime('%s', 'now') AS INTEGER) * 1000
	),
	(
		'weekly-sun',
		'ウィークリーリセット',
		'{"en":"Weekly reset","ja":"ウィークリーリセット"}',
		'DTSTART;TZID=Asia/Tokyo:20200105T060000' || char(10) || 'RRULE:FREQ=WEEKLY;BYDAY=SU',
		1,
		'Weekly content, reset every Sunday at 06:00 JST.',
		CAST(strftime('%s', 'now') AS INTEGER) * 1000,
		CAST(strftime('%s', 'now') AS INTEGER) * 1000
	),
	(
		'semimonthly-1-15',
		'半月リセット（1日・15日）',
		'{"en":"Semi-monthly reset (1st/15th)","ja":"半月リセット（1日・15日）"}',
		'DTSTART;TZID=Asia/Tokyo:20200101T060000' || char(10) || 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15',
		2,
		'Content resetting on the 1st and 15th of each month.',
		CAST(strftime('%s', 'now') AS INTEGER) * 1000,
		CAST(strftime('%s', 'now') AS INTEGER) * 1000
	),
	(
		'semimonthly-10-25',
		'半月リセット（10日・25日）',
		'{"en":"Semi-monthly reset (10th/25th)","ja":"半月リセット（10日・25日）"}',
		'DTSTART;TZID=Asia/Tokyo:20200110T060000' || char(10) || 'RRULE:FREQ=MONTHLY;BYMONTHDAY=10,25',
		3,
		'Content resetting on the 10th and 25th of each month.',
		CAST(strftime('%s', 'now') AS INTEGER) * 1000,
		CAST(strftime('%s', 'now') AS INTEGER) * 1000
	),
	(
		'monthly-1',
		'マンスリーリセット',
		'{"en":"Monthly reset","ja":"マンスリーリセット"}',
		'DTSTART;TZID=Asia/Tokyo:20200101T060000' || char(10) || 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1',
		4,
		'Content resetting on the 1st of each month.',
		CAST(strftime('%s', 'now') AS INTEGER) * 1000,
		CAST(strftime('%s', 'now') AS INTEGER) * 1000
	);
