import { Temporal } from 'temporal-polyfill';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  getNextCheckTime,
  getRecheckIntervalHours,
  getTimeUntilCheck,
  isDueForCheck,
} from './freshness';

describe('freshness', () => {
  // Use a fixed "now" for deterministic tests
  const NOW = 1736500000000; // Some fixed timestamp in ms

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Helper to create an Instant from hours/days ago
  const hoursAgo = (hours: number): Temporal.Instant =>
    Temporal.Instant.fromEpochMilliseconds(NOW - hours * 60 * 60 * 1000);

  const daysAgo = (days: number): Temporal.Instant => hoursAgo(days * 24);

  describe('getRecheckIntervalHours', () => {
    it('returns 1 hour minimum for very recent articles', () => {
      // Article published 1 hour ago -> age = 1 hour, interval = 1/24 = 0.04, clamped to 1
      expect(getRecheckIntervalHours(hoursAgo(1))).toBe(1);
    });

    it('returns 1 hour for 1-day-old articles', () => {
      // Article published 24 hours ago -> age = 24 hours, interval = 24/24 = 1
      expect(getRecheckIntervalHours(daysAgo(1))).toBe(1);
    });

    it('returns 3 hours for 3-day-old articles', () => {
      // Article published 3 days ago -> age = 72 hours, interval = 72/24 = 3
      expect(getRecheckIntervalHours(daysAgo(3))).toBe(3);
    });

    it('returns 7 hours for 1-week-old articles', () => {
      // Article published 7 days ago -> age = 168 hours, interval = 168/24 = 7
      expect(getRecheckIntervalHours(daysAgo(7))).toBe(7);
    });

    it('returns age-in-days for moderately old articles', () => {
      // Article published 60 days ago -> age = 1440 hours, interval = 1440/24 = 60
      expect(getRecheckIntervalHours(daysAgo(60))).toBe(60);
    });

    it('caps at 168 hours for very old articles (>168 days)', () => {
      // Article published 200 days ago -> age = 4800 hours, interval = 4800/24 = 200, clamped to 168
      expect(getRecheckIntervalHours(daysAgo(200))).toBe(168);
    });
  });

  describe('getNextCheckTime', () => {
    it('calculates next check time correctly for recent article', () => {
      const publishedAt = daysAgo(1); // 1 day ago
      const bodyFetchedAt = hoursAgo(2); // 2 hours ago
      // Interval for 1-day-old article = 1 hour
      // Next check = bodyFetchedAt + 1 hour = 1 hour ago
      const expected = bodyFetchedAt.epochMilliseconds + 1 * 60 * 60 * 1000;
      expect(
        getNextCheckTime(publishedAt, bodyFetchedAt).epochMilliseconds,
      ).toBe(expected);
    });

    it('calculates next check time correctly for older article', () => {
      const publishedAt = daysAgo(7); // 1 week ago
      const bodyFetchedAt = hoursAgo(4); // 4 hours ago
      // Interval for 7-day-old article = 7 hours
      // Next check = bodyFetchedAt + 7 hours = 3 hours from now
      const expected = bodyFetchedAt.epochMilliseconds + 7 * 60 * 60 * 1000;
      expect(
        getNextCheckTime(publishedAt, bodyFetchedAt).epochMilliseconds,
      ).toBe(expected);
    });
  });

  describe('isDueForCheck', () => {
    it('returns true when bodyFetchedAt is null', () => {
      expect(isDueForCheck(daysAgo(1), null)).toBe(true);
    });

    it('returns true when next check time has passed', () => {
      const publishedAt = daysAgo(1); // 1 day ago, interval = 1 hour
      const bodyFetchedAt = hoursAgo(2); // 2 hours ago
      // Next check = 2 hours ago + 1 hour = 1 hour ago (in the past)
      expect(isDueForCheck(publishedAt, bodyFetchedAt)).toBe(true);
    });

    it('returns false when next check time is in the future', () => {
      const publishedAt = daysAgo(7); // 1 week ago, interval = 7 hours
      const bodyFetchedAt = hoursAgo(2); // 2 hours ago
      // Next check = 2 hours ago + 7 hours = 5 hours from now (in the future)
      expect(isDueForCheck(publishedAt, bodyFetchedAt)).toBe(false);
    });

    it('returns true at exact boundary', () => {
      const publishedAt = daysAgo(1); // 1 day ago, interval = 1 hour
      const bodyFetchedAt = hoursAgo(1); // exactly 1 hour ago
      // Next check = 1 hour ago + 1 hour = now
      expect(isDueForCheck(publishedAt, bodyFetchedAt)).toBe(true);
    });
  });

  describe('getTimeUntilCheck', () => {
    it("returns 'now' when check is due", () => {
      const publishedAt = daysAgo(1);
      const bodyFetchedAt = hoursAgo(2);
      expect(getTimeUntilCheck(publishedAt, bodyFetchedAt)).toBe('now');
    });

    it('returns hours and minutes for future checks', () => {
      const publishedAt = daysAgo(7); // interval = 7 hours
      const bodyFetchedAt = hoursAgo(2); // 2 hours ago
      // Next check in 5 hours
      expect(getTimeUntilCheck(publishedAt, bodyFetchedAt)).toBe('5h 0m');
    });

    it('returns only minutes when less than an hour', () => {
      const publishedAt = daysAgo(1); // interval = 1 hour
      const bodyFetchedAt = Temporal.Instant.fromEpochMilliseconds(
        NOW - 30 * 60 * 1000,
      ); // 30 min ago
      // Next check in 30 minutes
      expect(getTimeUntilCheck(publishedAt, bodyFetchedAt)).toBe('30m');
    });
  });

  describe('getRecheckQueue logic simulation', () => {
    // This simulates what getRecheckQueue does to filter items
    const simulateRecheckQueue = (
      items: Array<{
        publishedAt: Temporal.Instant;
        bodyFetchedAt: Temporal.Instant | null;
      }>,
    ) => {
      const now = Temporal.Now.instant();
      return items
        .filter((item) => item.bodyFetchedAt !== null)
        .map((item) => ({
          ...item,
          nextCheckAt: getNextCheckTime(item.publishedAt, item.bodyFetchedAt!),
        }))
        .filter((item) => Temporal.Instant.compare(item.nextCheckAt, now) <= 0);
    };

    it('includes items that are due for recheck', () => {
      const items = [
        { publishedAt: daysAgo(3), bodyFetchedAt: hoursAgo(6) }, // 3-day-old, interval=3h, fetched 6h ago -> due
        { publishedAt: daysAgo(7), bodyFetchedAt: hoursAgo(2) }, // 7-day-old, interval=7h, fetched 2h ago -> NOT due
      ];
      const result = simulateRecheckQueue(items);
      expect(result).toHaveLength(1);
      expect(result[0].publishedAt).toBe(items[0].publishedAt);
    });

    it('excludes items without bodyFetchedAt', () => {
      const items = [
        { publishedAt: daysAgo(3), bodyFetchedAt: null }, // no body fetched
      ];
      const result = simulateRecheckQueue(items);
      expect(result).toHaveLength(0);
    });

    it('includes recently published items that were fetched and are due', () => {
      // Article published 2 days ago, body fetched 3 hours ago
      // Interval = 2 hours, so should be due
      const items = [{ publishedAt: daysAgo(2), bodyFetchedAt: hoursAgo(3) }];
      const result = simulateRecheckQueue(items);
      expect(result).toHaveLength(1);
    });
  });
});
