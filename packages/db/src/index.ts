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
// Query modules co-located with their schema files (DQX-51). Exported from the
// root barrel but deliberately NOT from schema/index.ts: relations.ts does
// `import * as schema from './schema'`, so pulling these heavier query modules
// (drizzle operators, d1-limits, the images/translations reads) into that
// barrel would drag them into the relations graph and risk a runtime import
// cycle. schema/index.ts stays limited to table defs + their own tiny inline
// helpers (deleteTranslation, getEnabledLanguages, syncArticleImages).
export * from './schema/events.queries';
export * from './schema/image-sources.queries';
export * from './schema/images.queries';
export * from './schema/translations.queries';
export * from './queries';
export * from './reset-events';
export * from './event-resolver';
