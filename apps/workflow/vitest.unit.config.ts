import { defineConfig } from 'vitest/config';

// The fast tier: platform-free unit tests (step logic, inline flow bodies).
// Integration tests against the real engine live in vitest.workers.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
  },
});
