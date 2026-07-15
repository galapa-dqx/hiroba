import cloudflare from '@astrojs/cloudflare';
import react from '@astrojs/react';
import sentry from '@sentry/astro';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'server',
  // Keep v6 whitespace handling; the v7 'jsx' default strips the space
  // between adjacent inline elements.
  compressHTML: true,
  adapter: cloudflare({
    imageService: 'compile',
  }),
  integrations: [
    react(),
    // Client-side Sentry only (init lives in sentry.client.config.ts).
    // Server-side stays on @sentry/cloudflare's wrapRequestHandler in
    // src/middleware.ts — the @sentry/astro server runtime assumes Node.
    sentry({
      enabled: { client: true, server: false },
      autoInstrumentation: { requestHandler: false },
      telemetry: false,
      // Upload client source maps when CI provides credentials; otherwise
      // skip quietly (local builds, forks).
      ...(process.env.SENTRY_AUTH_TOKEN
        ? {
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT_ADMIN,
            authToken: process.env.SENTRY_AUTH_TOKEN,
          }
        : { sourceMapsUploadOptions: { enabled: false } }),
    }),
  ],
});
