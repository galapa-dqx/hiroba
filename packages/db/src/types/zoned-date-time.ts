import { customType } from 'drizzle-orm/sqlite-core';
import { Temporal } from 'temporal-polyfill';

/**
 * Store a Temporal.ZonedDateTime as an RFC9557 timestamp in the db.
 *
 * For our purposes, we ignore the offset when parsing and omit it when serializing,
 * preferring to use the time zone identifier instead.
 */
export const zonedDateTime = customType<{
  data: Temporal.ZonedDateTime;
  driverData: string;
}>({
  dataType() {
    return 'text';
  },
  fromDriver(value: string): Temporal.ZonedDateTime {
    return Temporal.ZonedDateTime.from(value, { offset: 'ignore' });
  },
  toDriver(value: Temporal.ZonedDateTime): string {
    return value.toString({ offset: 'never' });
  },
});
