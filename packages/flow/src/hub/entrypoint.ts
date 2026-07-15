/**
 * FlowEntrypoint — the workflow-side shell. Builds the tracker from the def
 * and the real engine step, wires reports and joins to the hub, and emits the
 * two run-level status reports (it is the only code positioned to witness
 * "the body resolved/threw").
 *
 * `event.instanceId === runId` — the hub created the instance with
 * `create({ id: runId })`, so no correlation table exists anywhere.
 */

import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

import type { AnyFlowDef, ParamsOf } from '../define';
import type { FlowReporter } from '../snapshot';
import {
  createFlow,
  type EngineStep,
  type EngineStepConfig,
  type Flow,
  type FlowLogger,
  type JoinOutcome,
  type JoinPort,
} from '../tracker';
import { isActiveStatus, type FlowHubApi, type JoinEventPayload } from './api';

/** The hub binding every flow worker (and app caller) holds. Structural so
 *  the package needs no generated Env types. */
export type FlowHubEnv = {
  FLOW_HUB: {
    idFromName(name: string): unknown;
    get(id: unknown): unknown;
  };
  /** Log verbosity for the default flow logger: debug | info | warn | error |
   *  silent (unset/unrecognized = info) — the worker-wide convention. */
  LOG_LEVEL?: string;
};

/** The single well-known hub instance — ONE DO, ONE SQLite database. */
export function getFlowHub(env: FlowHubEnv): FlowHubApi & {
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
} {
  const ns = env.FLOW_HUB;
  return ns.get(ns.idFromName('hub')) as ReturnType<typeof getFlowHub>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Output travels through a status report to the hub (and to joined parents).
 *  It must survive JSON — anything that doesn't is dropped with a warning
 *  rather than failing a run that already did its work. */
function sanitizeOutput(output: unknown, log: FlowLogger): unknown {
  if (output === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(output)) as unknown;
  } catch (err) {
    log.warn('flow output is not JSON-serializable — dropped from hub', err);
    return undefined;
  }
}

// Higher rank = more severe. A message logs only when its rank >= threshold.
const LOG_RANK = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

/**
 * The default flow logger: console, every line prefixed `[<scope>]` (the flow
 * name, so interleaved runs stay legible), gated by the worker's LOG_LEVEL.
 * Workers has no built-in log-level filter — every console.* line reaches
 * observability — so the gate lives here.
 */
export function scopedConsoleLogger(
  scope: string,
  rawLevel?: string,
): FlowLogger {
  const level = rawLevel?.toLowerCase() as keyof typeof LOG_RANK | undefined;
  const threshold = (level && LOG_RANK[level]) || LOG_RANK.info;
  const at =
    (rank: number, sink: (...a: unknown[]) => void) =>
    (message: string, ...rest: unknown[]): void => {
      if (rank >= threshold) sink(`[${scope}] ${message}`, ...rest);
    };
  return {
    debug: at(LOG_RANK.debug, (...a) => console.debug(...a)),
    info: at(LOG_RANK.info, (...a) => console.info(...a)),
    warn: at(LOG_RANK.warn, (...a) => console.warn(...a)),
    error: at(LOG_RANK.error, (...a) => console.error(...a)),
  };
}

/**
 * Hub-backed join transport. The child identity is memoized in a step
 * (`<prefix>start`) — on parent replay after the child finished, a naked
 * start would spawn a fresh child; the memo pins the SAME child forever.
 * startAndWatch registers the waiter in the same hub call that returns the
 * child's status, and short-circuits a child that's ALREADY terminal at attach
 * (line below) — so the wait below only ever runs for a child still active.
 *
 * `sendEvent` only reaches an ALREADY-ARMED `waitForEvent`; there is no
 * buffering for a wait not yet reached. Two engine behaviours drive the shape
 * (both confirmed against the real workerd engine):
 *
 *   - waitForEvent ARMS ON CALL, not on await — so the wait is armed first,
 *     then the child's status is checked. A child that settles during (or
 *     after) that check is captured by the armed wait; only a child that
 *     settled in the gap BEFORE the wait existed (between startAndWatch and the
 *     arm) has fired its notification into the void.
 *   - an instance can resolve its OWN armed wait (hub.notifyParent → a
 *     reentrant sendEvent). So when the check finds the child already terminal,
 *     we don't abandon the armed wait to dangle — we nudge ourselves and the
 *     wait resolves at once.
 *
 * NO polling backstop right now (deliberately): the join rests entirely on the
 * notification — the hub's sendEvent when a still-active child settles, or the
 * self-nudge when the check finds it already terminal. A wait that times out
 * therefore means the notification was genuinely dropped, and we surface that
 * as a failed outcome so it's VISIBLE, rather than papering over it with a
 * re-poll loop. This is a probe of the event mechanism in production; if drops
 * show up, the timeout→getRun→re-arm loop goes back in. `waitTimeout` is the
 * ceiling on that visibility — generous so a legitimately slow child (a
 * localize generation) resolves via its event long before it trips.
 */
export function createHubJoinPort(
  hub: FlowHubApi,
  parentFlow: string,
  parentInstanceId: string,
  opts: { waitTimeout?: string | number } = {},
): JoinPort {
  const waitTimeout = opts.waitTimeout ?? '30 minutes';

  const toOutcome = (w: {
    status: string;
    error?: string | null;
    output?: unknown;
  }): JoinOutcome =>
    w.status === 'complete'
      ? { status: 'complete', output: w.output ?? null }
      : { status: 'failed', error: w.error ?? `child run ${w.status}` };

  return {
    join: async (childDef, params, { engine, namePrefix }) => {
      const watch = await engine.do(`${namePrefix}start`, () =>
        hub.startAndWatch(childDef.name, params, {
          instanceId: parentInstanceId,
          flow: parentFlow,
        }),
      );
      if (!isActiveStatus(watch.status)) return toOutcome(watch);

      // Arm the wait BEFORE checking (arm-on-call): a child settling from here
      // on — including during the check — wakes this wait rather than firing
      // into the void.
      const wait = engine.waitForEvent(`${namePrefix}wait`, {
        type: `flow:${watch.runId}`,
        timeout: waitTimeout,
      }) as Promise<{ payload: JoinEventPayload }>;

      // Fresh authoritative status. A child that settled in the start→arm gap
      // (its notification predated this wait) is terminal here; getRun also
      // reconciles a silently-dead child to 'unknown'.
      const run = await engine.do(`${namePrefix}check`, () =>
        hub.getRun(watch.runId),
      );
      if (!run || !isActiveStatus(run.status)) {
        // Terminal, but `wait` may never receive an event (the child's
        // notifyWaiters fired before this wait existed). Nudge ourselves so the
        // armed wait resolves — then fall through and read it, so there's a
        // single resolution path and no abandoned wait. Memoized: fires once,
        // replays clean.
        await engine.do(`${namePrefix}nudge`, () =>
          hub.notifyParent(watch.runId, {
            instanceId: parentInstanceId,
            flow: parentFlow,
          }),
        );
      }

      try {
        const event = await wait;
        return toOutcome(event.payload);
      } catch (err) {
        // No backstop: a timeout here means the notification never arrived.
        // Degrade (don't block) and make the drop visible.
        return {
          status: 'failed',
          error: `join wait failed: ${errorMessage(err)}`,
        };
      }
    },
  };
}

export abstract class FlowEntrypoint<
  Env extends FlowHubEnv,
  D extends AnyFlowDef,
  Out = unknown,
> extends WorkflowEntrypoint<Env, ParamsOf<D>> {
  abstract readonly def: D;

  abstract flow(
    f: Flow<D['steps']>,
    params: ParamsOf<D>,
    event: WorkflowEvent<ParamsOf<D>>,
  ): Promise<Out>;

  /** Domain cleanup on terminal failure (settle pipeline states, etc.).
   *  Runs as its own engine step before the failed status is reported. */
  onFailure?(params: ParamsOf<D>, error: unknown): Promise<void>;

  /** Override to tighten/loosen the bounded step defaults for this flow. */
  protected stepDefaults?: EngineStepConfig;
  /** Override to swap the default logger (console, scoped by the flow name,
   *  gated by env.LOG_LEVEL). */
  protected flowLogger(): FlowLogger {
    return scopedConsoleLogger(this.def.name, this.env.LOG_LEVEL);
  }

  async run(
    event: WorkflowEvent<ParamsOf<D>>,
    step: WorkflowStep,
  ): Promise<Out> {
    const log = this.flowLogger();
    const hub = getFlowHub(this.env);
    const runId = event.instanceId;
    // The engine types the payload Readonly<>; flows treat params as data.
    const params = event.payload as ParamsOf<D>;
    const reporter: FlowReporter = {
      report: (id, report) => hub.report(id, report),
    };
    const f = createFlow(
      this.def,
      step as unknown as EngineStep,
      reporter,
      runId,
      {
        joins: createHubJoinPort(hub, this.def.name, runId),
        defaults: this.stepDefaults,
        log,
      },
    );

    const safeReport = async (
      report: Parameters<FlowReporter['report']>[1],
    ): Promise<void> => {
      try {
        await hub.report(runId, report);
      } catch (err) {
        log.warn('flow status report failed', err);
      }
    };

    await safeReport({ kind: 'status', status: 'running' });
    try {
      const output = await this.flow(f, params, event);
      // Drain fire-and-forget step/unit reports first: the terminal status
      // must never overtake the facts it summarizes (false warnUnfinished,
      // SSE closing on a half-painted bar).
      await f.flush();
      await safeReport({
        kind: 'status',
        status: 'complete',
        output: sanitizeOutput(output, log),
      });
      return output;
    } catch (error) {
      if (this.onFailure) {
        try {
          await step.do('on-failure', () => this.onFailure!(params, error));
        } catch (cleanupError) {
          // Cleanup is best-effort: a throwing onFailure must not eat the
          // failed status report (the run would sit `running` at the hub
          // forever) nor mask the original error.
          log.error('onFailure cleanup step failed', cleanupError);
        }
      }
      await f.flush();
      await safeReport({
        kind: 'status',
        status: 'failed',
        error: errorMessage(error),
      });
      throw error; // untouched — the engine records the real failure
    }
  }
}
