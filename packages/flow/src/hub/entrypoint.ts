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

const consoleLogger: FlowLogger = {
  debug: (...a) => console.debug(...a),
  info: (...a) => console.info(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

/**
 * Hub-backed join transport. The child identity is memoized in a step
 * (`<prefix>start`) — on parent replay after the child finished, a naked
 * start would spawn a fresh child; the memo pins the SAME child forever.
 * startAndWatch registers the waiter in the same hub call that returns the
 * child's status, so there is no gap where the child finishes unobserved;
 * the waitForEvent timeout → poll → re-wait loop is the backstop for a
 * missed notification (hub evicted mid-notify, sendEvent racing hibernation).
 */
export function createHubJoinPort(
  hub: FlowHubApi,
  parentFlow: string,
  parentInstanceId: string,
  opts: { waitTimeout?: string | number; maxWaits?: number } = {},
): JoinPort {
  const waitTimeout = opts.waitTimeout ?? '30 minutes';
  const maxWaits = opts.maxWaits ?? 96; // ≈ 2 days at the default timeout

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

      for (let i = 0; i < maxWaits; i++) {
        try {
          const event = await engine.waitForEvent(`${namePrefix}wait-${i}`, {
            type: `flow:${watch.runId}`,
            timeout: waitTimeout,
          });
          // The real engine wraps the payload in a WorkflowStepEvent; the
          // inline harness hands the payload back directly.
          const payload = (
            event && typeof event === 'object' && 'payload' in event
              ? (event as { payload: unknown }).payload
              : event
          ) as JoinEventPayload;
          return toOutcome(payload);
        } catch {
          // Timeout (or transient failure): one authoritative status poll,
          // then re-wait. getRun reconciles a silently-dead child to
          // 'unknown', which maps to a failed outcome — no infinite wait.
          const run = await engine.do(`${namePrefix}poll-${i}`, () =>
            hub.getRun(watch.runId),
          );
          if (!run) {
            return { status: 'failed', error: 'child run vanished' };
          }
          if (!isActiveStatus(run.status)) return toOutcome(run);
        }
      }
      return {
        status: 'failed',
        error: `join gave up after ${maxWaits} waits`,
      };
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
  /** Override to swap the console logger (e.g. for a leveled logger). */
  protected flowLogger(): FlowLogger {
    return consoleLogger;
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
      await safeReport({
        kind: 'status',
        status: 'complete',
        output: sanitizeOutput(output, log),
      });
      return output;
    } catch (error) {
      if (this.onFailure) {
        await step.do('on-failure', () =>
          this.onFailure!(params, error),
        );
      }
      await safeReport({
        kind: 'status',
        status: 'failed',
        error: errorMessage(error),
      });
      throw error; // untouched — the engine records the real failure
    }
  }
}
