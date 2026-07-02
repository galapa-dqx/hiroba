import { customType } from 'drizzle-orm/sqlite-core';

/**
 * Store an arbitrary JSON-serializable value in a TEXT column.
 *
 * Used for `topics.blocks_ja` (a block tree). NULL round-trips as NULL — Drizzle
 * skips the custom (de)serialization for null values. Pair with a
 * `json_valid(...)` CHECK in the migration to keep the column well-formed.
 */
export const json = <T>(name: string) =>
  customType<{ data: T; driverData: string }>({
    dataType() {
      return 'text';
    },
    toDriver(value: T): string {
      return JSON.stringify(value);
    },
    fromDriver(value: string): T {
      return JSON.parse(value) as T;
    },
  })(name);
