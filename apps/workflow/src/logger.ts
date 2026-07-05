/**
 * Tiny leveled logger for the workflow worker.
 *
 * Cloudflare Workers has no built-in log-level filter: every console.* line is
 * captured by observability (`[observability]` in wrangler.toml) and surfaced in
 * `wrangler tail` / Logpush. So we gate here — a message below the configured
 * threshold never reaches console. The threshold comes from the `LOG_LEVEL` var
 * (wrangler.toml `[vars]`, overridable per-env, or via `.dev.vars` / the root
 * `.env` in local dev); unset or unrecognized falls back to "info".
 */

import type { WorkflowStep } from 'cloudflare:workers';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

// Higher rank = more severe. A message logs only when its rank >= the threshold.
const RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

function resolveLevel(raw: string | undefined): LogLevel {
  const v = raw?.toLowerCase();
  return v && v in RANK ? (v as LogLevel) : 'info';
}

export type Logger = {
  readonly level: LogLevel;
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
};

/**
 * Build a logger reading its threshold from `env.LOG_LEVEL`. `scope` is prefixed
 * to every line (e.g. "news:abc123") so interleaved workflow logs stay legible.
 */
export function createLogger(env: { LOG_LEVEL?: string }, scope = ''): Logger {
  const level = resolveLevel(env.LOG_LEVEL);
  const threshold = RANK[level];
  const prefix = scope ? `[${scope}] ` : '';
  const at =
    (rank: number, sink: (...a: unknown[]) => void) =>
    (message: string, ...rest: unknown[]): void => {
      if (rank >= threshold) sink(`${prefix}${message}`, ...rest);
    };
  return {
    level,
    debug: at(RANK.debug, (...a) => console.debug(...a)),
    info: at(RANK.info, (...a) => console.info(...a)),
    warn: at(RANK.warn, (...a) => console.warn(...a)),
    error: at(RANK.error, (...a) => console.error(...a)),
  };
}

/**
 * Run a workflow step with lifecycle logging: a debug line when the body starts
 * (re-fires on retry, so retries are visible) and an info line with the returned
 * summary when it resolves — or an error line if it throws.
 *
 * The logging lives *inside* the step body on purpose. A Workflow's `run()` is
 * replayed from the top on every resume, so anything logged between steps would
 * fire once per resume; a step body only runs on real execution.
 */
export async function runStep<T extends Rpc.Serializable<T>>(
  step: WorkflowStep,
  log: Logger,
  name: string,
  fn: () => Promise<T>,
): Promise<T> {
  return step.do(name, async () => {
    log.debug(`→ step "${name}" started`);
    const startedAt = Date.now();
    try {
      const result = await fn();
      log.info(`✓ step "${name}" done in ${Date.now() - startedAt}ms`, result);
      return result;
    } catch (err) {
      log.error(
        `✗ step "${name}" failed after ${Date.now() - startedAt}ms`,
        err,
      );
      throw err;
    }
  });
}
