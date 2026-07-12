/**
 * The hub's RPC surface — shared between the DO implementation (hub.ts), the
 * workflow-side client (entrypoint.ts), and app callers (admin/web routes).
 * Everything here must be structured-clonable: it travels over DO RPC.
 */

import type { Report, RunStatus, Snapshot } from '../snapshot';

/** `unknown` = the engine no longer knows the instance (reconciler verdict). */
export type HubRunStatus = RunStatus | 'unknown';

export const isActiveStatus = (s: HubRunStatus): boolean =>
  s === 'queued' || s === 'running';

export type StartOptions = {
  /** Minimum ms between start attempts for one (flow, key) while NO run is
   *  active — the page-view re-trigger throttle, generalized. In-flight runs
   *  always attach regardless. */
  cooldownMs?: number;
  /** Bypass the cooldown (admin/cron/self-healing streams). */
  force?: boolean;
};

export type StartResult =
  | { throttled: true }
  | {
      throttled?: false;
      runId: string;
      /** false = attached to an already-active run with the same key. */
      created: boolean;
      status: HubRunStatus;
    };

export type RunInfo = {
  runId: string;
  flow: string;
  key: string;
  params: unknown;
  status: HubRunStatus;
  error: string | null;
  output: unknown;
  createdAt: number;
  updatedAt: number;
};

/** startAndWatch's answer: current status AND waiter registration happened in
 *  one hub call, so there is no gap where the child finishes unobserved. */
export type WatchResult = {
  runId: string;
  status: HubRunStatus;
  error: string | null;
  output: unknown;
};

/** Terminal-notification payload sendEvent()ed to waiting parents. */
export type JoinEventPayload = {
  runId: string;
  status: HubRunStatus;
  error: string | null;
  output: unknown;
};

export type FlowHubApi = {
  start(
    flow: string,
    params: unknown,
    opts?: StartOptions,
  ): Promise<StartResult>;
  report(runId: string, report: Report): Promise<void>;
  getRun(runId: string): Promise<RunInfo | null>;
  getSnapshot(query: {
    runId?: string;
    flow?: string;
    key?: string;
  }): Promise<Snapshot | null>;
  listRuns(opts?: { flow?: string; limit?: number }): Promise<RunInfo[]>;
  startAndWatch(
    flow: string,
    params: unknown,
    parent: { instanceId: string; flow: string },
  ): Promise<WatchResult>;
};
