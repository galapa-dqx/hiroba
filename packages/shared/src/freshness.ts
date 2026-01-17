/**
 * Freshness calculation helpers for the Hiroba news system.
 *
 * These functions determine when articles should be rechecked for updates
 * based on their age. Older articles are checked less frequently.
 *
 * All timestamp parameters are Unix timestamps in SECONDS.
 * Internal calculations use milliseconds.
 */

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
 * @param publishedAt - When the article was published (Unix seconds)
 * @param bodyFetchedAt - When the body was last fetched (Unix seconds)
 * @returns Next check time in milliseconds (for comparison with Date.now())
 */
export function getNextCheckTime(
  publishedAt: number,
  bodyFetchedAt: number,
): number {
  const now = Date.now();
  const ageMs = now - publishedAt * 1000;
  const ageHours = ageMs / (1000 * 60 * 60);

  // Clamp interval between 1 hour and 168 hours (1 week)
  const intervalHours = Math.max(1, Math.min(168, ageHours / 24));
  const intervalMs = intervalHours * 60 * 60 * 1000;

  return bodyFetchedAt * 1000 + intervalMs;
}

/**
 * Check if an article's body is due for a recheck.
 *
 * @param publishedAt - When the article was published (Unix seconds)
 * @param bodyFetchedAt - When the body was last fetched (Unix seconds), or null if never
 * @returns True if the body should be rechecked
 */
export function isDueForCheck(
  publishedAt: number,
  bodyFetchedAt: number | null,
): boolean {
  // Never fetched = always due
  if (bodyFetchedAt === null) return true;

  const nextCheck = getNextCheckTime(publishedAt, bodyFetchedAt);
  return Date.now() >= nextCheck;
}

/**
 * Check if a translation is stale (source was published after translation).
 *
 * @param publishedAt - When the source content was published (Unix seconds)
 * @param translatedAt - When the translation was created (Unix seconds)
 * @returns True if the translation needs to be regenerated
 */
export function isTranslationStale(
  publishedAt: number,
  translatedAt: number,
): boolean {
  return publishedAt > translatedAt;
}

/**
 * Get human-readable time until next check.
 *
 * @param publishedAt - When the article was published (Unix seconds)
 * @param bodyFetchedAt - When the body was last fetched (Unix seconds)
 * @returns Human-readable string like "2h 30m" or "now"
 */
export function getTimeUntilCheck(
  publishedAt: number,
  bodyFetchedAt: number,
): string {
  const nextCheck = getNextCheckTime(publishedAt, bodyFetchedAt);
  const diff = nextCheck - Date.now();

  if (diff <= 0) return 'now';

  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

/**
 * Calculate the recheck interval for an article based on its age.
 *
 * @param publishedAt - When the article was published (Unix seconds)
 * @returns Interval in hours
 */
export function getRecheckIntervalHours(publishedAt: number): number {
  const now = Date.now();
  const ageMs = now - publishedAt * 1000;
  const ageHours = ageMs / (1000 * 60 * 60);

  return Math.max(1, Math.min(168, ageHours / 24));
}
