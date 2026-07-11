/**
 * Events table - stores calendar events extracted from news/topics.
 *
 * Supports four event types:
 * - multiDay: spans multiple days (startTime + endTime as dates)
 * - allDay: single all-day event (startTime as date, no endTime)
 * - span: timed event with duration (startTime + endTime as datetimes)
 * - mark: point-in-time milestone (startTime as datetime, no endTime)
 *
 * Translations are stored in the translations table with itemType="event".
 */

import { sql } from 'drizzle-orm';
import {
  check,
  index,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

import { instant } from '../types/instant';
import { zonedDateTime } from '../types/zoned-date-time';

export const events = sqliteTable(
  'events',
  {
    // Primary identifier
    id: text('id').primaryKey(),

    // Event type determines interpretation of time fields
    type: text('type').notNull(), // "multiDay" | "allDay" | "span" | "mark"

    // Japanese title (source for translation)
    titleJa: text('title_ja').notNull(),

    // ZonedDateTime strings stored as RFC9557 timestamps
    startTime: zonedDateTime('start_time').notNull(),
    endTime: zonedDateTime('end_time'), // null for allDay and mark

    // Link to source content (optional)
    sourceType: text('source_type'), // "news" | "topic"
    sourceId: text('source_id'), // FK to news_items.id or topics.id

    // Metadata
    createdAt: instant('created_at').notNull(), // epoch ms (Temporal.Instant)
  },
  // Mirrors the CHECK constraints in migration 0008. Drizzle has no STRICT
  // table option, so strict typing lives only in the raw migration.
  (table) => [
    check(
      'events_type_valid',
      sql`${table.type} IN ('multiDay', 'allDay', 'span', 'mark')`,
    ),
    // multiDay/span require an end_time; allDay/mark must not have one.
    check(
      'events_end_time_by_type',
      sql`CASE
        WHEN ${table.type} IN ('multiDay', 'span') THEN ${table.endTime} IS NOT NULL
        WHEN ${table.type} IN ('allDay', 'mark') THEN ${table.endTime} IS NULL
      END`,
    ),
  ],
);

// Type exports
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventType = 'multiDay' | 'allDay' | 'span' | 'mark';

/**
 * event_sources — provenance join between a canonical event and every article
 * that mentions it (many-to-many). An event's identity is no longer scoped to a
 * single source (its id is allocated once, then matched on re-extraction), so a
 * campaign named in a roundup *and* in its own dedicated page is one `events`
 * row linked from both articles here.
 *
 * `events.source_type`/`source_id` still holds the *primary* source — the one
 * the calendar links to (the article whose headline actually names the event) —
 * recomputed from this set whenever it changes.
 *
 * Schedule events never appear here: they're deterministic and replaced
 * wholesale, so they keep using `events.source_id` directly.
 */
export const eventSources = sqliteTable(
  'event_sources',
  {
    eventId: text('event_id').notNull(),
    sourceType: text('source_type').notNull(), // "news" | "topic"
    sourceId: text('source_id').notNull(),
    createdAt: instant('created_at').notNull(), // epoch ms (Temporal.Instant)
  },
  (table) => [
    // One link per (event, article). event_id first so the PK also serves
    // link lookups and orphan GC by event.
    primaryKey({
      columns: [table.eventId, table.sourceType, table.sourceId],
    }),
    // Reverse lookup: "events in this article" + per-source re-extraction.
    index('event_sources_by_source').on(table.sourceType, table.sourceId),
    check(
      'event_sources_type_valid',
      sql`${table.sourceType} IN ('news', 'topic')`,
    ),
  ],
);

export type EventSource = typeof eventSources.$inferSelect;
export type NewEventSource = typeof eventSources.$inferInsert;
