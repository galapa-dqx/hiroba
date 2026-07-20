import { defineRelations } from 'drizzle-orm';

import * as schema from './schema';

/**
 * Relational-query config for `db.query.*` (RQBv2). Bare for now — every table
 * is queryable; cross-table relations get added here as call sites need them.
 */
export const relations = defineRelations(schema);
