/**
 * Date utility functions for parsing Japanese (JST) time zone dates.
 *
 * Source pages from hiroba.dqx.jp express times in JST wall-clock with no
 * explicit offset. We parse them as Asia/Tokyo and return a Temporal.Instant
 * (the absolute moment), which is how all point-in-time values are stored.
 */

import { Temporal } from 'temporal-polyfill';

const JST = 'Asia/Tokyo';

/**
 * Parse a date string written in JST and return the corresponding instant.
 *
 * Input formats: "2024/01/15", "2024-01-15", "2024/01/15 10:30".
 * Date-only input is anchored to midnight JST. Unparseable input falls back
 * to the current instant.
 */
export function parseJstDate(dateStr: string): Temporal.Instant {
  if (!dateStr) return Temporal.Now.instant();

  // Normalize separators
  const normalized = dateStr.replace(/\//g, '-').trim();

  // Try parsing with time: "2024-01-15 10:30"
  let match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})$/);
  if (match) {
    const [, year, month, day, hour, minute] = match;
    return Temporal.ZonedDateTime.from({
      timeZone: JST,
      year: Number(year),
      month: Number(month),
      day: Number(day),
      hour: Number(hour),
      minute: Number(minute),
    }).toInstant();
  }

  // Try parsing date only: "2024-01-15"
  match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (match) {
    const [, year, month, day] = match;
    return Temporal.PlainDate.from({
      year: Number(year),
      month: Number(month),
      day: Number(day),
    })
      .toZonedDateTime(JST)
      .toInstant();
  }

  // Fallback to current time
  return Temporal.Now.instant();
}
