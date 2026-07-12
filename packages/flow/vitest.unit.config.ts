import { defineConfig } from 'vitest/config';

// The fast tier: platform-free unit tests over the core + inline harness.
// Integration tests against the real engine live in vitest.workers.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
