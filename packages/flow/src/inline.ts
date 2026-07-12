/**
 * runFlowInline — the fast orchestration-test tier. Runs a flow body against a
 * fake engine step and an in-memory reporter: no miniflare, no DO, plain
 * vitest in milliseconds.
 *
 * The fake engine emulates the two engine behaviors that matter to
 * orchestration logic:
 *
 *   - MEMOIZATION: every `do` return is stored by step name (after a
 *     structuredClone round-trip, which also approximates the engine's
 *     "step returns must serialize" rule). Pass one run's `memo` into a second
 *     run to emulate a replay/resume: memoized bodies do not re-execute.
 *   - NAMING: the trace records every engine-step interaction in order, with
 *     the exact prefixed names production would ship to the Workflows
 *     dashboard and vitest introspectors.
 *
 * What it deliberately does NOT emulate: retries (a thrown body just throws),
 * timeouts, hibernation, cross-isolate replay. Those belong to the
 * pool-workers integration tier (DQX-18's test bed).
 */

import type { AnyFlowDef, ParamsOf } from './define';
import { createRunState, type SnapshotFor } from './snapshot';
import {
  createFlow,
  type EngineStep,
  type Flow,
  type FlowLogger,
  type JoinPort,
} from './tracker';

export type InlineTraceEntry = {
  type: 'do' | 'sleep' | 'waitForEvent';
  name: string;
  /** True when a `do` was answered from memo (emulated replay) or a stub. */
  cached?: boolean;
  stubbed?: boolean;
};

export type RunFlowInlineOptions = {
  /** Answers for engine steps by EXACT step name (e.g. `translate/plan`).
   *  A function stub is invoked (and may throw to simulate a failing step);
   *  a plain value is returned as-is. Stubs win over the real body but lose
   *  to memo — a memoized step already "ran". */
  stubs?: Record<string, unknown | ((name: string) => unknown)>;
  /** waitForEvent payloads by event `type`. Missing type = throw, matching a
   *  timeout with no fallback. */
  events?: Record<string, unknown>;
  /** Join transport; absent means join/joinSettled throw (as in production
   *  without a hub client). */
  joins?: JoinPort;
  /** A previous run's memo — pass it back in to emulate replay/resume. */
  memo?: Map<string, unknown>;
  log?: FlowLogger;
};

export type InlineResult<D extends AnyFlowDef, T> = {
  /** Present when the body resolved; `error` is set instead when it threw. */
  output?: T;
  error?: unknown;
  trace: InlineTraceEntry[];
  /** One snapshot per report, in order — the frames an SSE client would see. */
  frames: SnapshotFor<D>[];
  /** The final snapshot (terminal status included). */
  snapshot: SnapshotFor<D>;
  /** Steps left neither terminal nor skipped — the hub's completeness check. */
  unfinishedSteps: string[];
  /** Feed back into a second run to emulate replay. */
  memo: Map<string, unknown>;
  runId: string;
};

let inlineRunCounter = 0;

export async function runFlowInline<D extends AnyFlowDef, T>(
  def: D,
  body: (f: Flow<D['steps']>, params: ParamsOf<D>) => Promise<T>,
  params: ParamsOf<D>,
  opts: RunFlowInlineOptions = {},
): Promise<InlineResult<D, T>> {
  const runId = `inline:${def.name}:${++inlineRunCounter}`;
  const memo = opts.memo ?? new Map<string, unknown>();
  const trace: InlineTraceEntry[] = [];

  const state = createRunState(def, runId);
  const frames: SnapshotFor<D>[] = [];
  const reporter = {
    report: (_runId: string, report: Parameters<typeof state.apply>[0]) => {
      state.apply(report);
      frames.push(state.snapshot());
    },
  };

  const engine: EngineStep = {
    do: async <R>(
      name: string,
      configOrFn: unknown,
      maybeFn?: () => Promise<R>,
    ): Promise<R> => {
      const fn = (maybeFn ?? configOrFn) as () => Promise<R>;
      if (memo.has(name)) {
        trace.push({ type: 'do', name, cached: true });
        return structuredClone(memo.get(name)) as R;
      }
      const stub = opts.stubs?.[name];
      let value: R;
      if (stub !== undefined) {
        trace.push({ type: 'do', name, stubbed: true });
        value = (typeof stub === 'function' ? stub(name) : stub) as R;
      } else {
        trace.push({ type: 'do', name });
        value = await fn();
      }
      // The clone round-trip is the serialization check: a class instance or
      // function smuggled through a step return fails here like it would fail
      // the real engine's persistence.
      memo.set(name, structuredClone(value));
      return value;
    },
    sleep: (name) => {
      trace.push({ type: 'sleep', name });
      return Promise.resolve();
    },
    waitForEvent: (name, options) => {
      trace.push({ type: 'waitForEvent', name });
      const payload = opts.events?.[options.type];
      if (payload === undefined) {
        return Promise.reject(
          new Error(
            `runFlowInline: no stubbed event for type "${options.type}" ` +
              `(waitForEvent "${name}") — pass it via opts.events`,
          ),
        );
      }
      return Promise.resolve(structuredClone(payload));
    },
  };

  const flow = createFlow(def, engine, reporter, runId, {
    joins: opts.joins,
    log: opts.log,
  });

  // Emulate the FlowEntrypoint shell: status running at entry, terminal
  // status on the way out — so frames end the way production frames end.
  reporter.report(runId, { kind: 'status', status: 'running' });
  const base = {
    trace,
    frames,
    memo,
    runId,
  };
  try {
    const output = await body(flow, params);
    reporter.report(runId, { kind: 'status', status: 'complete' });
    return {
      ...base,
      output,
      snapshot: state.snapshot(),
      unfinishedSteps: state.unfinishedSteps(),
    };
  } catch (error) {
    reporter.report(runId, {
      kind: 'status',
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      ...base,
      error,
      snapshot: state.snapshot(),
      unfinishedSteps: state.unfinishedSteps(),
    };
  }
}
