/**
 * The tracker — `createFlow` wraps a real engine step in the typed, reporting
 * `Flow` surface the flow bodies are written against.
 *
 * The framework observes and names; the engine executes. Every primitive here
 * bottoms out in plain `engine.do` / `engine.sleep` / `engine.waitForEvent`
 * calls with deterministic names — the engine keeps sole ownership of
 * durability, memoization, retries, and hibernation. Delete the reporter and
 * the flow still runs correctly (blind, but correct).
 *
 * Report placement rules (see docs/flow-framework/progress-design.md):
 *   - Unit/lifecycle reports live INSIDE step bodies: they fire on real
 *     execution only, so a replay over memoized steps costs zero RPCs. The
 *     crash window (report landed, step didn't persist → body re-runs →
 *     duplicate report) is covered by PK idempotency.
 *   - Phase/map coordination reports live OUTSIDE bodies by necessity; they
 *     re-fire on replay and are idempotent overwrites. Bounded per replay.
 *   - Reports are best-effort and never awaited on the hot path: a tracking
 *     failure must never fail the work.
 *
 * State crosses step boundaries only via step returns (memoized) or D1 —
 * never closures. `map`/`drain` collect and RETURN the memoized results for
 * exactly this reason: on resume, completed steps memoize and their closures
 * never run, so a closure-accumulated array silently loses every already-done
 * unit.
 */

import type { AnyFlowDef, FlowDef, StepsShape } from './define';
import type { FlowReporter, Report } from './snapshot';

// -----------------------------------------------------------------------------
// Engine surface — structural subset of cloudflare:workers' WorkflowStep, kept
// minimal so this package has no runtime dependency on the platform and the
// inline harness can swap in a fake. Re-verify against workers-types on
// upgrade (the "platform churn" thread in the design doc).
// -----------------------------------------------------------------------------

export type EngineStepConfig = {
  retries?: {
    limit: number;
    delay: string | number;
    backoff?: 'constant' | 'linear' | 'exponential';
  };
  timeout?: string | number;
};

export type EngineStep = {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  do<T>(
    name: string,
    config: EngineStepConfig,
    fn: () => Promise<T>,
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  waitForEvent(
    name: string,
    options: { type: string; timeout?: string | number },
  ): Promise<unknown>;
};

/**
 * Bounded step defaults, inherited from today's `runStep`: the platform
 * default (5 retries × 10-minute timeout, exponential backoff) lets a
 * persistently-failing LLM step churn for ~40 minutes before settling. Cap
 * retries at 2; keep the 10-minute per-attempt timeout as a backstop for the
 * legitimately-long image steps.
 */
export const DEFAULT_STEP_CONFIG: EngineStepConfig = {
  retries: { limit: 2, delay: '10 seconds', backoff: 'exponential' },
  timeout: '10 minutes',
};

export type FlowLogger = {
  debug(message: string, ...rest: unknown[]): void;
  info(message: string, ...rest: unknown[]): void;
  warn(message: string, ...rest: unknown[]): void;
  error(message: string, ...rest: unknown[]): void;
};

const SILENT_LOG: FlowLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

// -----------------------------------------------------------------------------
// Joins — transport port only. The FlowHub client implements this (DQX-18);
// until then the default port throws. join/joinSettled do NOT report units:
// reporting belongs to the enclosing primitive (a join inside `map` is that
// map's unit; the map wrapper reports it).
// -----------------------------------------------------------------------------

export type JoinOutcome<T = unknown> =
  | { status: 'complete'; output: T }
  | { status: 'failed'; error: string };

export type JoinPort = {
  join(
    childDef: AnyFlowDef,
    params: unknown,
    ctx: { engine: EngineStep; namePrefix: string },
  ): Promise<JoinOutcome>;
};

/** A joined child flow failed and the parent treats it as a prerequisite. */
export class FlowJoinError extends Error {
  constructor(
    readonly childFlow: string,
    readonly childError: string,
  ) {
    super(`joined flow "${childFlow}" failed: ${childError}`);
    this.name = 'FlowJoinError';
  }
}

// -----------------------------------------------------------------------------
// The Flow surface
// -----------------------------------------------------------------------------

/** Worker returns this from a `drain` worker to signal "empty page — stop
 *  dispatching". Sound only while emptiness is monotonic (no interior holes);
 *  in-flight overrun past the empty page is harmless and bounded by
 *  `concurrency`. Never crosses a step boundary (symbols don't serialize) —
 *  the page step memoizes a `{ stop: true }` marker instead. */
export const DRAIN_STOP: unique symbol = Symbol('DRAIN_STOP');

/** Scoped engine step handed to a `phase` body. Names are prefixed with the
 *  phase key (`translate/plan`, `translate/batch/wait-3`) — legible traces,
 *  stable mock targets for vitest introspection, valid `restart({from})`
 *  anchors. */
export type PhaseStep = {
  do<T>(
    name: string,
    fn: () => Promise<T>,
    config?: EngineStepConfig,
  ): Promise<T>;
  sleep(name: string, duration: string | number): Promise<void>;
  /** Sleep/check until `isDone` or the budget is exhausted. Returns the last
   *  value and whether the predicate was ever satisfied — the caller decides
   *  what an unsettled poll means (batch translate deliberately
   *  warns-and-retrieves-anyway). Sleeps FIRST: a poll right after a submit
   *  is a wasted check. */
  poll<T>(
    name: string,
    opts: { every: string | number; atMost: number },
    check: () => Promise<T>,
    isDone: (value: T) => boolean,
  ): Promise<{ value: T; settled: boolean }>;
  waitForEvent<T = unknown>(
    name: string,
    options: { type: string; timeout?: string | number },
  ): Promise<T>;
};

/** Low-level unit handle — the escape hatch for shapes `map`/`drain` can't
 *  express (keyset loops where page N+1 needs page N's cursor). */
export type OpenHandle = {
  /** Set the denominator once known; `null` = indeterminate. */
  expect(total: number | null): Promise<void>;
  unit<T>(id: string, fn: () => Promise<T>): Promise<T>;
  /** Explicitly completes the step — arithmetic can't, when total is null. */
  done(): Promise<void>;
};

export type Flow<S extends StepsShape> = {
  step<T>(
    key: keyof S & string,
    fn: () => Promise<T>,
    config?: EngineStepConfig,
  ): Promise<T>;

  phase<T>(key: keyof S & string, fn: (s: PhaseStep) => Promise<T>): Promise<T>;

  map<I, T>(
    key: keyof S & string,
    list: () => Promise<I[]>,
    unit: (item: I) => Promise<T>,
    opts: { concurrency: number; id: (item: I) => string },
  ): Promise<T[]>;

  drain<T>(
    key: keyof S & string,
    worker: (page: number) => Promise<T | typeof DRAIN_STOP>,
    opts: { concurrency: number },
  ): Promise<T[]>;

  skip(key: keyof S & string, reason?: string): void;

  open(key: keyof S & string): OpenHandle;

  join<CT, CP = unknown>(
    key: keyof S & string,
    def: FlowDef<string, CP, StepsShape>,
    params: CP,
  ): Promise<CT>;
  joinSettled<CT, CP = unknown>(
    key: keyof S & string,
    def: FlowDef<string, CP, StepsShape>,
    params: CP,
  ): Promise<JoinOutcome<CT>>;
};

export type CreateFlowOptions = {
  /** Per-flow override of the bounded step defaults. */
  defaults?: EngineStepConfig;
  /** Hub-backed join transport. Absent (pre-DQX-18, inline without stubs),
   *  join/joinSettled throw. */
  joins?: JoinPort;
  log?: FlowLogger;
};

// -----------------------------------------------------------------------------
// Implementation
// -----------------------------------------------------------------------------

export function createFlow<D extends AnyFlowDef>(
  def: D,
  engine: EngineStep,
  reporter: FlowReporter,
  runId: string,
  opts: CreateFlowOptions = {},
): Flow<D['steps']> {
  const log = opts.log ?? SILENT_LOG;
  const defaults = opts.defaults ?? DEFAULT_STEP_CONFIG;

  /** Best-effort, never awaited, never throws: tracking must not fail work. */
  const report = (r: Report): void => {
    try {
      void Promise.resolve(reporter.report(runId, r)).catch((err: unknown) => {
        log.warn(`flow report dropped (${r.kind})`, err);
      });
    } catch (err) {
      log.warn(`flow report dropped (${r.kind})`, err);
    }
  };

  const assertDeclared = (key: string): void => {
    if (!(key in def.steps)) {
      throw new Error(`Flow "${def.name}": step "${key}" is not declared`);
    }
  };

  /** Per-isolate attempt counter for the retry badge. Resets on eviction —
   *  cosmetic undercount, never load-bearing. */
  const attempts = new Map<string, number>();
  const bump = (name: string): number => {
    const next = (attempts.get(name) ?? 0) + 1;
    attempts.set(name, next);
    return next;
  };

  /** One engine step with lifecycle logging + reports inside the body. */
  const runBody = <T>(
    name: string,
    stepKey: string,
    config: EngineStepConfig,
    fn: () => Promise<T>,
    o: { unit?: string; reportStepState?: boolean },
  ): Promise<T> =>
    engine.do(name, config, async () => {
      const attempt = bump(name);
      if (o.reportStepState) {
        report({ kind: 'step', step: stepKey, state: 'running', attempt });
      }
      log.debug(`→ step "${name}" started (attempt ${attempt})`);
      const startedAt = Date.now();
      try {
        const out = await fn();
        if (o.unit !== undefined) {
          report({ kind: 'unit', step: stepKey, unit: o.unit, attempt });
        }
        if (o.reportStepState) {
          report({ kind: 'step', step: stepKey, state: 'complete' });
        }
        log.info(`✓ step "${name}" done in ${Date.now() - startedAt}ms`);
        return out;
      } catch (err) {
        // A step can flap failed → running → complete across engine retries.
        // Consumers key "this run is dead" off top-level status, never off an
        // individual segment being failed.
        if (o.reportStepState) {
          report({ kind: 'step', step: stepKey, state: 'failed' });
        }
        log.error(
          `✗ step "${name}" failed after ${Date.now() - startedAt}ms`,
          err,
        );
        throw err; // untouched — the engine owns retry/terminal semantics
      }
    });

  const phaseStep = (key: string): PhaseStep => ({
    do: (name, fn, config) =>
      runBody(`${key}/${name}`, key, config ?? defaults, fn, {}),
    sleep: (name, duration) => engine.sleep(`${key}/${name}`, duration),
    poll: async (name, pollOpts, check, isDone) => {
      if (pollOpts.atMost < 1) {
        throw new Error(`poll "${key}/${name}": atMost must be >= 1`);
      }
      let value!: Awaited<ReturnType<typeof check>>;
      for (let i = 0; i < pollOpts.atMost; i++) {
        await engine.sleep(`${key}/${name}/wait-${i}`, pollOpts.every);
        value = await runBody(
          `${key}/${name}/check-${i}`,
          key,
          defaults,
          check,
          {},
        );
        if (isDone(value)) return { value, settled: true };
      }
      return { value, settled: false };
    },
    waitForEvent: <T>(
      name: string,
      options: { type: string; timeout?: string | number },
    ) => engine.waitForEvent(`${key}/${name}`, options) as Promise<T>,
  });

  /** Dispatch `worker` over `items` at bounded concurrency. Rejection is
   *  eager (Promise.all semantics); in-flight losers are not cancelled — they
   *  run to completion and memoize, so the engine's step retry re-runs only
   *  the unfinished units. Don't "fix" that. */
  const runPool = async <I>(
    items: I[],
    concurrency: number,
    worker: (item: I, index: number) => Promise<void>,
  ): Promise<void> => {
    let next = 0;
    const lanes = Array.from(
      { length: Math.max(1, Math.min(concurrency, items.length)) },
      async () => {
        while (next < items.length) {
          const index = next++;
          await worker(items[index], index);
        }
      },
    );
    await Promise.all(lanes);
  };

  const flow: Flow<D['steps']> = {
    step: (key, fn, config) => {
      assertDeclared(key);
      return runBody(key, key, config ?? defaults, fn, {
        unit: '1',
        reportStepState: true,
      });
    },

    phase: async (key, fn) => {
      assertDeclared(key);
      // Coordination reports sit outside engine bodies: they re-fire on every
      // replay and are idempotent overwrites. Attempt is omitted — replays
      // would inflate it into noise.
      report({ kind: 'step', step: key, state: 'running' });
      try {
        const out = await fn(phaseStep(key));
        report({ kind: 'unit', step: key, unit: '1' });
        report({ kind: 'step', step: key, state: 'complete' });
        return out;
      } catch (err) {
        report({ kind: 'step', step: key, state: 'failed' });
        throw err;
      }
    },

    map: async (key, list, unit, mapOpts) => {
      assertDeclared(key);
      // The list step is the memoized, replay-safe source of truth for the
      // unit set. Unit ids come from the domain (mapOpts.id), never array
      // indices — indices reshuffle when the source data changes under a
      // retried run.
      const items = await runBody(`${key}/list`, key, defaults, list, {});
      report({ kind: 'step', step: key, state: 'running' });
      report({ kind: 'total', step: key, total: items.length });
      const results = new Array<unknown>(items.length);
      try {
        await runPool(items, mapOpts.concurrency, async (item, index) => {
          const unitId = mapOpts.id(item);
          results[index] = await runBody(
            `${key}/${unitId}`,
            key,
            defaults,
            () => unit(item),
            { unit: unitId },
          );
        });
      } catch (err) {
        report({ kind: 'step', step: key, state: 'failed' });
        throw err;
      }
      report({ kind: 'step', step: key, state: 'complete' });
      return results as Awaited<ReturnType<typeof unit>>[];
    },

    drain: async (key, worker, drainOpts) => {
      assertDeclared(key);
      report({ kind: 'step', step: key, state: 'running' });
      report({ kind: 'total', step: key, total: null });

      // The pool owns the page counter AND the stop flag — a single dispatch
      // loop closes the claim/check race workers would have. "Stop" means stop
      // DISPATCHING; pages already in flight finish (harmlessly empty). The
      // sentinel page reports no unit: it was the probe that found the end,
      // not work.
      let stopped = false;
      let nextPage = 1;
      let firstError: unknown;
      const collected: { page: number; value: unknown }[] = [];
      const inFlight = new Set<Promise<void>>();

      const dispatch = (page: number): Promise<void> =>
        runBody(
          `${key}/page-${page}`,
          key,
          defaults,
          async () => {
            const value = await worker(page);
            if (value === DRAIN_STOP) return { stop: true as const };
            report({ kind: 'unit', step: key, unit: `page-${page}` });
            return { stop: false as const, value };
          },
          {},
        ).then((res) => {
          if (res.stop) stopped = true;
          else collected.push({ page, value: res.value });
        });

      while (!stopped && firstError === undefined) {
        while (
          inFlight.size < drainOpts.concurrency &&
          !stopped &&
          firstError === undefined
        ) {
          const task = dispatch(nextPage++).catch((err: unknown) => {
            // A worker throw shares the stop-dispatching path with DRAIN_STOP;
            // they differ only in whether drain resolves or rejects.
            firstError ??= err;
          });
          const tracked: Promise<void> = task.finally(() => {
            inFlight.delete(tracked);
          });
          inFlight.add(tracked);
        }
        if (inFlight.size === 0) break;
        await Promise.race(inFlight);
      }
      await Promise.all([...inFlight].map((p) => p.catch(() => {})));

      if (firstError !== undefined) {
        report({ kind: 'step', step: key, state: 'failed' });
        throw firstError;
      }
      report({ kind: 'step', step: key, state: 'complete' });
      // Page order, not completion order — parallel workers finish shuffled.
      return collected
        .sort((a, b) => a.page - b.page)
        .map((entry) => entry.value) as never;
    },

    skip: (key, reason) => {
      assertDeclared(key);
      report({ kind: 'step', step: key, state: 'skipped', reason });
    },

    open: (key) => {
      assertDeclared(key);
      report({ kind: 'step', step: key, state: 'running' });
      return {
        expect: (total) => {
          report({ kind: 'total', step: key, total });
          return Promise.resolve();
        },
        unit: (id, fn) =>
          runBody(`${key}/${id}`, key, defaults, fn, { unit: id }),
        done: () => {
          report({ kind: 'step', step: key, state: 'complete' });
          return Promise.resolve();
        },
      };
    },

    join: async (key, childDef, params) => {
      const outcome = await joinVia(key, childDef, params);
      if (outcome.status === 'failed') {
        throw new FlowJoinError(childDef.name, outcome.error);
      }
      return outcome.output as never;
    },

    joinSettled: async (key, childDef, params) =>
      (await joinVia(key, childDef, params)) as never,
  };

  const joinVia = (
    key: string,
    childDef: AnyFlowDef,
    params: unknown,
  ): Promise<JoinOutcome> => {
    assertDeclared(key);
    if (!opts.joins) {
      throw new Error(
        `Flow "${def.name}": join("${key}") requires a JoinPort — the ` +
          `FlowHub client provides one in production; pass \`joins\` to ` +
          `runFlowInline in tests.`,
      );
    }
    return opts.joins.join(childDef, params, {
      engine,
      namePrefix: `${key}/`,
    });
  };

  return flow;
}
