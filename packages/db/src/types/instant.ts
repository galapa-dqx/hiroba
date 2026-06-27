import { Temporal } from 'temporal-polyfill';
import { customType } from 'drizzle-orm/sqlite-core';

/**
 * Store a Temporal.Instant as a millisecond-precision timestamp in the db
 */
export const instant = customType<{
  data: Temporal.Instant;
  driverData: number;
}>({
  dataType() {
    return 'number';
  },
  fromDriver(value: number): Temporal.Instant {
    return Temporal.Instant.fromEpochMilliseconds(value);
  },
  toDriver(value: Temporal.Instant): number {
    return value.epochMilliseconds;
  },
});
