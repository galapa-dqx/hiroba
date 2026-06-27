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

import { sqliteTable, text } from 'drizzle-orm/sqlite-core';

import { instant } from '../types/instant';
import { zonedDateTime } from '../types/zoned-date-time';

export const events = sqliteTable('events', {
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
});

// Type exports
export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
export type EventType = 'multiDay' | 'allDay' | 'span' | 'mark';
