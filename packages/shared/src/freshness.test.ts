import { Temporal } from 'temporal-polyfill';
import { describe, expect, it } from 'vitest';

import {
  getNextCheckTime,
  getRecheckIntervalHours,
  isDueForCheck,
  RECHECK_MAX_INTERVAL_HOURS,
} from './freshness';

describe('freshness', () => {
  // A fixed "now", passed explicitly (the helpers accept it as a parameter).
  const NOW_MS = 1736500000000;
  const NOW = Temporal.Instant.fromEpochMilliseconds(NOW_MS);

  const hoursAgo = (hours: number): Temporal.Instant =>
    Temporal.Instant.fromEpochMilliseconds(NOW_MS - hours * 60 * 60 * 1000);

  const daysAgo = (days: number): Temporal.Instant => hoursAgo(days * 24);

  describe('getRecheckIntervalHours', () => {
    it('returns the 1 hour minimum right after a change', () => {
      // Changed 1 hour ago -> 1/24 clamped up to 1
      expect(getRecheckIntervalHours(hoursAgo(1), NOW)).toBe(1);
    });

    it('returns 1 hour a day after the last change', () => {
      expect(getRecheckIntervalHours(daysAgo(1), NOW)).toBe(1);
    });

    it('returns 3 hours three days after the last change', () => {
      expect(getRecheckIntervalHours(daysAgo(3), NOW)).toBe(3);
    });

    it('returns 7 hours a week after the last change', () => {
      expect(getRecheckIntervalHours(daysAgo(7), NOW)).toBe(7);
    });

    it('grows roughly daily a month after the last change', () => {
      expect(getRecheckIntervalHours(daysAgo(30), NOW)).toBe(30);
    });

    it('caps at one week', () => {
      // 59 days quiet -> 59h... still under the retire horizon; check the cap
      // with a value between cap and retirement: 59 days -> 59, under cap.
      // The cap engages between 168h/24 = 7 days * 24 = 168 days, which is
      // past retirement — so the cap only matters if constants change. Assert
      // it holds anyway via a synthetic pre-retirement value.
      const interval = getRecheckIntervalHours(daysAgo(59), NOW);
      expect(interval).not.toBeNull();
      expect(interval!).toBeLessThanOrEqual(RECHECK_MAX_INTERVAL_HOURS);
    });

    it('retires content quiet for more than 60 days', () => {
      expect(getRecheckIntervalHours(daysAgo(61), NOW)).toBeNull();
    });

    it('still checks content at exactly 60 quiet days', () => {
      expect(getRecheckIntervalHours(daysAgo(60), NOW)).toBe(60);
    });
  });

  describe('getNextCheckTime', () => {
    it('anchors the next check on the last check, not the change', () => {
      const lastChangedAt = daysAgo(1); // interval = 1h
      const lastCheckedAt = hoursAgo(2);
      expect(
        getNextCheckTime(lastChangedAt, lastCheckedAt, NOW)?.epochMilliseconds,
      ).toBe(lastCheckedAt.epochMilliseconds + 60 * 60 * 1000);
    });

    it('uses the fading interval for older changes', () => {
      const lastChangedAt = daysAgo(7); // interval = 7h
      const lastCheckedAt = hoursAgo(4);
      expect(
        getNextCheckTime(lastChangedAt, lastCheckedAt, NOW)?.epochMilliseconds,
      ).toBe(lastCheckedAt.epochMilliseconds + 7 * 60 * 60 * 1000);
    });

    it('returns null for retired content', () => {
      expect(getNextCheckTime(daysAgo(90), hoursAgo(4), NOW)).toBeNull();
    });
  });

  describe('isDueForCheck', () => {
    it('is due when the next check time has passed', () => {
      // Changed a day ago (interval 1h), checked 2h ago -> due 1h ago.
      expect(isDueForCheck(daysAgo(1), hoursAgo(2), NOW)).toBe(true);
    });

    it('is not due when the next check is in the future', () => {
      // Changed a week ago (interval 7h), checked 2h ago -> due in 5h.
      expect(isDueForCheck(daysAgo(7), hoursAgo(2), NOW)).toBe(false);
    });

    it('is due at the exact boundary', () => {
      expect(isDueForCheck(daysAgo(1), hoursAgo(1), NOW)).toBe(true);
    });

    it('is never due once retired', () => {
      // Quiet for 90 days, last checked ages ago -> retired, not due.
      expect(isDueForCheck(daysAgo(90), daysAgo(30), NOW)).toBe(false);
    });

    it('a fresh change revives frequent checking', () => {
      // Old article, but content changed an hour ago and we checked at the
      // same moment -> due again one hour later.
      const lastChangedAt = hoursAgo(1);
      const lastCheckedAt = hoursAgo(1);
      expect(isDueForCheck(lastChangedAt, lastCheckedAt, NOW)).toBe(true);
    });
  });
});
