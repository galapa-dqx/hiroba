import * as Sentry from '@sentry/astro';

// Browser-side Sentry for the admin app. The DSN is inlined at build time
// from PUBLIC_ADMIN_SENTRY_DSN (set in the deploy workflow; DSNs are public
// by design). Local builds leave it unset and the SDK stays disabled.
const dsn = import.meta.env.PUBLIC_ADMIN_SENTRY_DSN as string | undefined;

Sentry.init({
  dsn,
  enabled: Boolean(dsn),
  environment: 'production',
  sendDefaultPii: false,
  // Internal, low-traffic app — trace client interactions at the same rate
  // as the server middleware so client→server traces line up.
  integrations: [Sentry.browserTracingIntegration()],
  tracesSampleRate: 0.25,
});
