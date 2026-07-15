import cloudflare from '@astrojs/cloudflare';
import sentry from '@sentry/astro';
import { defineConfig } from 'astro/config';

export default defineConfig({
  output: 'server',
  // Keep v6 whitespace handling; the v7 'jsx' default strips the space
  // between adjacent inline elements (pagination, nav links, time ranges).
  compressHTML: true,
  adapter: cloudflare({
    // We don't use astro:assets; keep the build-time image service so the
    // adapter doesn't require a Cloudflare Images binding (the v13 default).
    imageService: 'compile',
  }),
  integrations: [
    // Client-side Sentry only (init lives in sentry.client.config.ts).
    // Server-side stays on @sentry/cloudflare's wrapRequestHandler in
    // src/middleware.ts — the @sentry/astro server runtime assumes Node.
    sentry({
      enabled: { client: true, server: false },
      autoInstrumentation: { requestHandler: false },
      telemetry: false,
      // Upload client source maps only when CI provides the full credential
      // set — a partial set (e.g. token without org/project) would make the
      // bundler plugin fail the build. Otherwise skip quietly (local builds,
      // forks).
      ...(process.env.SENTRY_AUTH_TOKEN &&
      process.env.SENTRY_ORG &&
      process.env.SENTRY_PROJECT_WEB
        ? {
            org: process.env.SENTRY_ORG,
            project: process.env.SENTRY_PROJECT_WEB,
            authToken: process.env.SENTRY_AUTH_TOKEN,
          }
        : { sourceMapsUploadOptions: { enabled: false } }),
    }),
  ],
});
