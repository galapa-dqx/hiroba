import { drizzle } from 'drizzle-orm/d1';

import { relations } from './relations';
import * as schema from './schema';

/**
 * Create a Drizzle database client for D1.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema, relations });
}

export type Database = ReturnType<typeof createDb>;
