/**
 * reset_milestones — admin-managed recurring "content reset" definitions.
 *
 * DQX resets various content on server-side cronjobs (the daily 06:00 JST reset,
 * the weekly Sunday reset, semi-monthly and monthly resets — see
 * https://ethene.wiki/wiki/Reset_Times). Nothing on hiroba.dqx.jp announces
 * them, so they can't be scraped; the admin curates them here instead.
 *
 * Each row is a recurrence expressed as an iCal RRULE (RFC 5545, incl. its
 * `DTSTART;TZID=Asia/Tokyo:…` line) plus an inline per-language name. A nightly
 * task materializes the next horizon of occurrences into the `events` table as
 * `type='mark'`, `sourceType='reset'` rows (with title translations), so the
 * calendar renders them through the ordinary milestone path — see
 * `reset-events.ts` and `replaceResetEvents`/`pruneResetEvents` in queries.ts.
 */

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { instant } from '../types/instant';
import { json } from '../types/json';

export const resetMilestones = sqliteTable(
  'reset_milestones',
  {
    /** Stable slug, e.g. "daily", "weekly-sun", "semimonthly-1-15". */
    id: text('id').primaryKey(),

    /** Canonical Japanese name (translation source + ultimate fallback). */
    titleJa: text('title_ja').notNull(),

    /** Per-language display names incl. "en"; falls back lang → en → title_ja. */
    titles: json<Record<string, string>>('titles').notNull(),

    /** Full iCal string: `DTSTART;TZID=Asia/Tokyo:…` + `RRULE:…`. */
    rrule: text('rrule').notNull(),

    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),

    /** Order the names are joined in a merged (coincident) milestone label. */
    sortOrder: integer('sort_order').notNull().default(0),

    /** Optional admin-only "what resets" blurb; not shown on the calendar. */
    note: text('note'),

    createdAt: instant('created_at').notNull(),
    updatedAt: instant('updated_at').notNull(),
  },
  (table) => [
    // `titles` must be a well-formed JSON object (mirrors the migration CHECK).
    check('reset_milestones_titles_json', sql`json_valid(${table.titles})`),
  ],
);

export type ResetMilestone = typeof resetMilestones.$inferSelect;
export type NewResetMilestone = typeof resetMilestones.$inferInsert;
