/**
 * Test-only helper: spins up an in-memory D1 (via Miniflare) with the real
 * migrations applied, so query helpers run against production-equivalent SQLite
 * — same custom SQL functions (`instr`, `json_valid`) and CHECK constraints.
 *
 * The migrations live in `apps/workflow/migrations` but are generated from this
 * package's schema (see `drizzle.config.ts`), so replaying them here keeps the
 * test schema in lockstep with what ships.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Miniflare } from 'miniflare';

import { createDb, type Database } from './client';

const MIGRATIONS_DIR = fileURLToPath(
  new URL('../../../apps/workflow/migrations', import.meta.url),
);

/** Tables to wipe on `reset()`, in no particular order (no cross-table FKs). */
const TABLES = [
  'events',
  'glossary',
  'images',
  'news_items',
  'topics',
  'translations',
];

/** Read every migration, in filename order, split into individual statements. */
function loadMigrationStatements(): string[] {
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const statements: string[] = [];
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    for (const stmt of sql.split('--> statement-breakpoint')) {
      const trimmed = stmt.trim();
      if (trimmed) statements.push(trimmed);
    }
  }
  return statements;
}

export type TestDb = {
  /** Drizzle client wired to the in-memory D1. */
  db: Database;
  /** Delete all rows from every table — call in `beforeEach`. */
  reset(): Promise<void>;
  /** Tear down the underlying Miniflare instance — call in `afterAll`. */
  dispose(): Promise<void>;
};

/**
 * Create a fresh in-memory database with migrations applied. Create one per
 * test file (`beforeAll`), `reset()` between tests, `dispose()` at the end.
 */
export async function createTestDb(): Promise<TestDb> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default {};',
    d1Databases: { DB: ':memory:' },
  });

  const d1 = await mf.getD1Database('DB');
  for (const stmt of loadMigrationStatements()) {
    await d1.prepare(stmt).run();
  }

  // Miniflare's D1Database is structurally the workers-types D1Database.
  const db = createDb(d1 as unknown as D1Database);

  return {
    db,
    async reset() {
      for (const table of TABLES) {
        await d1.prepare(`DELETE FROM ${table}`).run();
      }
      // Reset AUTOINCREMENT counters (images.id) so ids are deterministic.
      await d1.prepare(`DELETE FROM sqlite_sequence`).run();
    },
    async dispose() {
      await mf.dispose();
    },
  };
}
