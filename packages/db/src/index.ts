/**
 * @hiroba/db - Database client, schema, and queries
 *
 * This package provides the Drizzle ORM client factory, schema definitions,
 * and query functions for the Hiroba news translation system.
 */

export { createDb, type Database } from './client';
export { chunked, IN_CHUNK } from './d1-limits';
export { relations, withLocalizedTitle } from './relations';
export * from './schema';
// Query modules co-located with their schema files (DQX-51). Kept out of the
// schema barrel so relations.ts's `import * as schema` sees only table defs.
export * from './schema/events.queries';
export * from './schema/image-sources.queries';
export * from './schema/images.queries';
export * from './schema/translations.queries';
export * from './queries';
export * from './reset-events';
export * from './event-resolver';
