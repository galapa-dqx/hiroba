import * as Sentry from '@sentry/cloudflare';
import { defineMiddleware } from 'astro:middleware';
import { env, waitUntil } from 'cloudflare:workers';

// Adapter v13 no longer exposes the ExecutionContext on locals; the
// cloudflare:workers module's request-scoped waitUntil fills the one hole
// Sentry needs (flushing events past the response). passThroughOnException
// isn't available at module level — a no-op keeps default error semantics.
const executionCtx = {
  waitUntil,
  passThroughOnException: () => {},
} as ExecutionContext;

export const onRequest = defineMiddleware((context, next) => {
  // Bind the whole request (page render reached via next()) into a Sentry
  // request scope so captureException calls anywhere downstream attach to it
  // and flush via the execution context's waitUntil.
  return Sentry.wrapRequestHandler(
    {
      options: {
        dsn: env.SENTRY_DSN,
        environment: 'production',
        // Admin is low-traffic and internal, so a higher sample rate than the
        // public web front-end is affordable.
        tracesSampleRate: 0.25,
        // Structured logs: ship the app's console.warn/error to Sentry Logs
        // (explicit Sentry.logger.* calls also flow once this is enabled).
        enableLogs: true,
        // Trace metrics (Sentry.metrics.count/gauge/distribution). Default-on
        // in the SDK; set explicitly to document intent.
        enableMetrics: true,
        sendDefaultPii: false,
        integrations: [
          Sentry.consoleLoggingIntegration({ levels: ['warn', 'error'] }),
        ],
      },
      // Astro hands us a standard Request; Sentry's Cloudflare types want the
      // workerd Request (with cf properties). Same object at runtime.
      request: context.request as Parameters<
        typeof Sentry.wrapRequestHandler
      >[0]['request'],
      context: executionCtx,
    },
    () => next(),
  );
});
