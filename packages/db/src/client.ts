import { drizzle } from 'drizzle-orm/d1';

import * as schema from './schema';

/**
 * Create a Drizzle database client for D1.
 */
export function createDb(d1: D1Database) {
  return drizzle(d1, { schema });
}

export type Database = ReturnType<typeof createDb>;
