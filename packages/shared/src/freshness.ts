/**
 * Freshness calculation helpers for the Hiroba news system.
 *
 * Articles are rechecked for edits after publication on a fading schedule
 * anchored to the last time their content *actually changed* (publication
 * counts as the first change). Content that keeps changing keeps getting
 * checked frequently; content that has sat still fades out and is eventually
 * retired from checking entirely.
 *
 *   interval = clamp(hoursSince(lastChange) / FADE_DIVISOR, MIN, MAX)
 *   nextCheck = lastChecked + interval
 *   retired when hoursSince(lastChange) > RETIRE_AFTER
 *
 * With the defaults: content that changed an hour ago is rechecked hourly;
 * a week after its last change every ~7 hours; a month after, roughly daily;
 * capped at weekly — and after 60 quiet days we assume it will never change
 * again and stop checking.
 *
 * All timestamp parameters are Temporal.Instant values (absolute moments).
 */

import { Temporal } from 'temporal-polyfill';

const HOUR_MS = 60 * 60 * 1000;

export const RECHECK_MIN_INTERVAL_HOURS = 1;
export const RECHECK_MAX_INTERVAL_HOURS = 168; // 1 week
export const RECHECK_FADE_DIVISOR = 24;
export const RECHECK_RETIRE_AFTER_HOURS = 60 * 24; // 60 days of no changes

/**
 * The recheck interval for content whose last change was `lastChangedAt`,
 * evaluated at `now`. Null when the content is retired (quiet for so long
 * that we assume it will never change again).
 */
export function getRecheckIntervalHours(
  lastChangedAt: Temporal.Instant,
  now: Temporal.Instant = Temporal.Now.instant(),
): number | null {
  const sinceChangeHours =
    (now.epochMilliseconds - lastChangedAt.epochMilliseconds) / HOUR_MS;
  if (sinceChangeHours > RECHECK_RETIRE_AFTER_HOURS) return null;
  return Math.max(
    RECHECK_MIN_INTERVAL_HOURS,
    Math.min(
      RECHECK_MAX_INTERVAL_HOURS,
      sinceChangeHours / RECHECK_FADE_DIVISOR,
    ),
  );
}

/**
 * When content should next be rechecked.
 *
 * @param lastChangedAt - Last time the content is known to have changed
 *   (publication for content never seen to change since).
 * @param lastCheckedAt - Last time the source was polled.
 * @returns The next due instant, or null when the content is retired.
 */
export function getNextCheckTime(
  lastChangedAt: Temporal.Instant,
  lastCheckedAt: Temporal.Instant,
  now: Temporal.Instant = Temporal.Now.instant(),
): Temporal.Instant | null {
  const intervalHours = getRecheckIntervalHours(lastChangedAt, now);
  if (intervalHours === null) return null;
  return lastCheckedAt.add({
    milliseconds: Math.round(intervalHours * HOUR_MS),
  });
}

/**
 * Whether content is due for a recheck right now. Retired content is never
 * due.
 */
export function isDueForCheck(
  lastChangedAt: Temporal.Instant,
  lastCheckedAt: Temporal.Instant,
  now: Temporal.Instant = Temporal.Now.instant(),
): boolean {
  const nextCheck = getNextCheckTime(lastChangedAt, lastCheckedAt, now);
  if (nextCheck === null) return false;
  return Temporal.Instant.compare(now, nextCheck) >= 0;
}
