/**
 * The cross-table, cross-app query core, split by domain (DQX-52). Table-scoped
 * reads/writes live beside their schema files (DQX-51: schema/*.queries.ts);
 * admin stats + lists live in apps/admin (DQX-54); source-page lookups in
 * apps/workflow (DQX-53). This barrel re-exports the remaining core so
 * consumers keep importing from '@hiroba/db' (and internal '../queries').
 */

export * from './articles';
export * from './recheck';
