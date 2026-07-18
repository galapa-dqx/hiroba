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
