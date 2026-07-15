import * as Sentry from '@sentry/astro';

// Browser-side Sentry for the public site. The DSN is inlined at build time
// from PUBLIC_WEB_SENTRY_DSN (set in the deploy workflow; DSNs are public by
// design, so exposure in the bundle is fine). Local builds leave it unset and
// the SDK stays disabled.
const dsn = import.meta.env.PUBLIC_WEB_SENTRY_DSN as string | undefined;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: 'production',
  sendDefaultPii: false,
  // Errors only on the public site — client tracing would burn span quota on
  // anonymous traffic; the server middleware already samples traces at 5%.
  tracesSampleRate: 0,
  // Drop errors thrown by third-party scripts and browser extensions; only
  // frames from our own origins count.
  allowUrls: [/https?:\/\/(news|img\.news)\.galapa\.app/],
});
