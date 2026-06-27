/**
 * Freshness calculation helpers for the Hiroba news system.
 *
 * These functions determine when articles should be rechecked for updates
 * based on their age. Older articles are checked less frequently.
 *
 * All timestamp parameters are Temporal.Instant values (absolute moments).
 */

import { Temporal } from 'temporal-polyfill';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Calculate when an article's body should next be rechecked.
 *
 * Formula: interval_hours = clamp(age_in_hours / 24, min=1, max=168)
 *
 * This means:
 * - 1-day-old article → recheck every 1 hour
 * - 1-week-old article → recheck every 7 hours
 * - 1-month+ old article → recheck weekly (168 hours max)
 *
 * @param publishedAt - When the article was published
 * @param bodyFetchedAt - When the body was last fetched
 * @returns The instant at which the next check is due
 */
export function getNextCheckTime(
  publishedAt: Temporal.Instant,
  bodyFetchedAt: Temporal.Instant,
): Temporal.Instant {
  const now = Temporal.Now.instant();
  const ageHours =
    (now.epochMilliseconds - publishedAt.epochMilliseconds) / HOUR_MS;

  // Clamp interval between 1 hour and 168 hours (1 week)
  const intervalHours = Math.max(1, Math.min(168, ageHours / 24));

  return bodyFetchedAt.add({
    milliseconds: Math.round(intervalHours * HOUR_MS),
  });
}

/**
 * Check if an article's body is due for a recheck.
 *
 * @param publishedAt - When the article was published
 * @param bodyFetchedAt - When the body was last fetched, or null if never
 * @returns True if the body should be rechecked
 */
export function isDueForCheck(
  publishedAt: Temporal.Instant,
  bodyFetchedAt: Temporal.Instant | null,
): boolean {
  // Never fetched = always due
  if (bodyFetchedAt === null) return true;

  const nextCheck = getNextCheckTime(publishedAt, bodyFetchedAt);
  return Temporal.Instant.compare(Temporal.Now.instant(), nextCheck) >= 0;
}

/**
 * Check if a translation is stale (source was published after translation).
 *
 * @param publishedAt - When the source content was published
 * @param translatedAt - When the translation was created
 * @returns True if the translation needs to be regenerated
 */
export function isTranslationStale(
  publishedAt: Temporal.Instant,
  translatedAt: Temporal.Instant,
): boolean {
  return Temporal.Instant.compare(publishedAt, translatedAt) > 0;
}

/**
 * Get human-readable time until next check.
 *
 * @param publishedAt - When the article was published
 * @param bodyFetchedAt - When the body was last fetched
 * @returns Human-readable string like "2h 30m" or "now"
 */
export function getTimeUntilCheck(
  publishedAt: Temporal.Instant,
  bodyFetchedAt: Temporal.Instant,
): string {
  const nextCheck = getNextCheckTime(publishedAt, bodyFetchedAt);
  const diffMs =
    nextCheck.epochMilliseconds - Temporal.Now.instant().epochMilliseconds;

  if (diffMs <= 0) return 'now';

  const hours = Math.floor(diffMs / HOUR_MS);
  const minutes = Math.floor((diffMs % HOUR_MS) / (60 * 1000));

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Calculate the recheck interval for an article based on its age.
 *
 * @param publishedAt - When the article was published
 * @returns Interval in hours
 */
export function getRecheckIntervalHours(publishedAt: Temporal.Instant): number {
  const ageHours =
    (Temporal.Now.instant().epochMilliseconds - publishedAt.epochMilliseconds) /
    HOUR_MS;

  return Math.max(1, Math.min(168, ageHours / 24));
}
