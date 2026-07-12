import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The integration tier: the FlowHub DO + FlowEntrypoint against the real
// Workflows engine (workerd via miniflare), driven by the toy flows in
// test/fixtures. Real retries, real hibernation, real sendEvent.
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.jsonc' },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    testTimeout: 30_000,
  },
});
