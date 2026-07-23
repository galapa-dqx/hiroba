import { defineConfig } from 'vitest/config';

// Miniflare-D1 semantics tests for the admin-only query modules (src/lib/
// *-queries.test.ts), run against the shared @hiroba/db/test-db harness —
// the same unit tier apps/workflow uses for its co-located queries.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
