/**
 * FlowHub — ONE Durable Object, ONE SQLite database, all control-plane state.
 *
 * The hub is the store/deriver of the object model (docs/flow-framework.md):
 * it applies producer reports idempotently, derives `current` as COUNT(*),
 * stamps `seq`, and fans out snapshots. It adds no facts of its own, with one
 * exception: the lazy reconciler back-fills a status for a run whose producer
 * died mid-sentence.
 *
 * start() is LOCK-FREE. The instance id is generated HERE, so the durable
 * claim (INSERT) happens before the engine create:
 *
 *   1. SELECT active run for (flow, key)          — attach if found
 *   2. INSERT the new row                         — same synchronous block as
 *      the SELECT; the DO is single-threaded between awaits, so 1+2 are atomic
 *      and the partial unique index is pure backstop
 *   3. await binding.create({ id: runId })        — the ONLY await; on failure
 *      the row is settled `failed` (not deleted — a concurrent caller may
 *      already hold the runId) and the error rethrown
 *
 * Mount it once per deployment under the well-known instance name 'hub'
 * (getFlowHub in entrypoint.ts): one SQLite database is the point.
 */

import { DurableObject } from 'cloudflare:workers';

import type { AnyFlowDef } from '../define';
import type { Report, Snapshot, StepState } from '../snapshot';
import {
  isActiveStatus,
  type FlowHubApi,
  type HubRunStatus,
  type RunInfo,
  type StartOptions,
  type StartResult,
  type WatchResult,
} from './api';

/** Structural subset of a Workflow binding — resolved from env by name. */
type WorkflowBindingLike = {
  create(options: { id: string; params: unknown }): Promise<{ id: string }>;
  get(id: string): Promise<{
    status(): Promise<{ status: string; error?: unknown; output?: unknown }>;
    sendEvent(event: { type: string; payload?: unknown }): Promise<void>;
  }>;
};

export type FlowRegistration = {
  def: AnyFlowDef;
  /** The env key of this flow's workflow binding (e.g. 'ARTICLE_WORKFLOW'). */
  binding: string;
};

/** Settled runs older than this are pruned (piggybacked on listRuns). */
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Active rows untouched for this long get an engine status probe. Long
 *  hibernations (batch translate) don't report for hours — the probe just
 *  confirms liveness and bumps updated_at so it re-checks at this cadence. */
const RECONCILE_AFTER_MS = 5 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id     TEXT PRIMARY KEY,
    flow       TEXT NOT NULL,
    key        TEXT NOT NULL,
    params     TEXT NOT NULL,
    status     TEXT NOT NULL,
    error      TEXT,
    output     TEXT,
    seq        INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS runs_active_key
    ON runs(flow, key) WHERE status IN ('queued','running');
  CREATE INDEX IF NOT EXISTS runs_by_created ON runs(created_at);
  CREATE TABLE IF NOT EXISTS steps (
    run_id  TEXT NOT NULL,
    step    TEXT NOT NULL,
    state   TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0,
    total   INTEGER,
    ord     INTEGER NOT NULL,
    PRIMARY KEY (run_id, step)
  );
  CREATE TABLE IF NOT EXISTS units (
    run_id TEXT NOT NULL,
    step   TEXT NOT NULL,
    unit   TEXT NOT NULL,
    PRIMARY KEY (run_id, step, unit)
  );
  CREATE TABLE IF NOT EXISTS waiters (
    child_run_id       TEXT NOT NULL,
    parent_instance_id TEXT NOT NULL,
    parent_flow        TEXT NOT NULL,
    PRIMARY KEY (child_run_id, parent_instance_id)
  );
  CREATE TABLE IF NOT EXISTS throttle (
    flow         TEXT NOT NULL,
    key          TEXT NOT NULL,
    last_attempt INTEGER NOT NULL,
    PRIMARY KEY (flow, key)
  );
`;

const terminal = (s: HubRunStatus): boolean => !isActiveStatus(s);

/** Engine status → hub status. Everything in-flight collapses to 'running';
 *  'unknown' means the engine no longer knows the instance. */
function fromEngineStatus(status: string): HubRunStatus {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
    case 'paused':
    case 'waiting':
    case 'waitingForPause':
      return 'running';
    case 'complete':
      return 'complete';
    case 'errored':
    case 'terminated':
      return 'failed';
    default:
      return 'unknown';
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

/**
 * Build the FlowHub DO class for a set of flow registrations. The
 * registration list is the ONE name→binding map in the system — build it
 * where the hub is mounted and nowhere else.
 */
/** Instance surface of the generated hub class — the RPC API plus the SSE
 *  fetch handler, on a real DurableObject. */
export type FlowHubInstance = DurableObject<Record<string, unknown>> &
  FlowHubApi & { fetch(request: Request): Promise<Response> };

export type FlowHubClass = {
  new (ctx: DurableObjectState, env: Record<string, unknown>): FlowHubInstance;
};

export function createFlowHub(flows: FlowRegistration[]): FlowHubClass {
  const registry = new Map(flows.map((f) => [f.def.name, f]));

  return class FlowHub
    extends DurableObject<Record<string, unknown>>
    implements FlowHubApi
  {
    private readonly sql = this.ctx.storage.sql;
    /** SSE listeners per runId — in-memory; a reconnect re-subscribes. */
    private readonly listeners = new Map<
      string,
      Set<{ send: (snap: Snapshot) => void; close: () => void }>
    >();

    constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
      super(ctx, env);
      this.sql.exec(SCHEMA);
    }

    private reg(flow: string): FlowRegistration {
      const reg = registry.get(flow);
      if (!reg) {
        throw new Error(
          `FlowHub: flow "${flow}" is not registered — add it to createFlowHub()`,
        );
      }
      return reg;
    }

    private binding(flow: string): WorkflowBindingLike {
      const reg = this.reg(flow);
      const binding = this.env[reg.binding];
      if (!binding) {
        throw new Error(
          `FlowHub: env binding "${reg.binding}" for flow "${flow}" is missing`,
        );
      }
      return binding as WorkflowBindingLike;
    }

    // -------------------------------------------------------------------------
    // start
    // -------------------------------------------------------------------------

    async start(
      flow: string,
      params: unknown,
      opts: StartOptions = {},
    ): Promise<StartResult> {
      const reg = this.reg(flow);
      const key = reg.def.key(params);

      // Attach-or-fall-through. A fresh active row attaches directly; a STALE
      // one gets the same lazy reconcile every read path runs — attaching to
      // a corpse would both hand the caller a dead run and block the dedup
      // slot forever. reconcile() awaits (engine probe), so after it the
      // world may have changed and the loop re-checks from the top; the
      // final no-active-row SELECT and the INSERT below share one
      // synchronous block, which is what keeps the claim atomic.
      for (let guard = 0; guard < 5; guard++) {
        const active = this.sql
          .exec(
            `SELECT * FROM runs
             WHERE flow = ? AND key = ? AND status IN ('queued','running')
             LIMIT 1`,
            flow,
            key,
          )
          .toArray()[0];
        if (!active) break;
        const run = this.rowToRun(active);
        if (Date.now() - run.updatedAt < RECONCILE_AFTER_MS) {
          return { runId: run.runId, created: false, status: run.status };
        }
        const fresh = await this.reconcile(run);
        if (isActiveStatus(fresh.status)) {
          return { runId: fresh.runId, created: false, status: fresh.status };
        }
        // Settled by the reconcile — loop; the next SELECT sees either no
        // active row (create below) or a racer's fresh run (attach to it).
      }
      const now = Date.now();

      if (!opts.force && opts.cooldownMs) {
        const row = this.sql
          .exec(
            `SELECT last_attempt FROM throttle WHERE flow = ? AND key = ?`,
            flow,
            key,
          )
          .toArray()[0];
        if (row && now - (row.last_attempt as number) < opts.cooldownMs) {
          return { throttled: true };
        }
      }

      const runId = crypto.randomUUID();
      try {
        this.sql.exec(
          `INSERT INTO runs (run_id, flow, key, params, status, seq, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)`,
          runId,
          flow,
          key,
          JSON.stringify(params ?? null),
          now,
          now,
        );
      } catch (err) {
        // The partial unique index is the claim's backstop. Today no await
        // sits between the attach loop's final SELECT and this INSERT, so a
        // racer can't exist — but the documented contract (the loser
        // attaches) must not depend on that block staying await-free across
        // future edits.
        const racer = this.sql
          .exec(
            `SELECT run_id, status FROM runs
             WHERE flow = ? AND key = ? AND status IN ('queued','running')
             LIMIT 1`,
            flow,
            key,
          )
          .toArray()[0];
        if (racer) {
          return {
            runId: racer.run_id as string,
            created: false,
            status: racer.status as HubRunStatus,
          };
        }
        throw err;
      }
      // Seed the FULL pending step map eagerly — the bar draws every segment
      // on frame one.
      Object.entries(reg.def.steps).forEach(([step, desc], ord) => {
        this.sql.exec(
          `INSERT INTO steps (run_id, step, state, attempt, total, ord)
           VALUES (?, ?, 'pending', 0, ?, ?)`,
          runId,
          step,
          desc.kind === 'units' ? null : 1,
          ord,
        );
      });
      try {
        await this.binding(flow).create({ id: runId, params });
      } catch (err) {
        // Settle as failed rather than DELETE: a caller that attached between
        // our INSERT and this failure holds the runId — it should observe a
        // failed run, not a vanished one.
        this.sql.exec(
          // seq bump included: SSE listeners drop non-increasing seq, and
          // this write is the frame that tells them the run settled.
          `UPDATE runs SET status = 'failed', error = ?, updated_at = ?, seq = seq + 1 WHERE run_id = ?`,
          `engine create failed: ${errorMessage(err)}`,
          Date.now(),
          runId,
        );
        this.fanout(runId);
        throw err;
      }
      // Stamped only after a SUCCESSFUL create: the cooldown throttles
      // re-triggers of runs that actually happened — an engine outage must
      // not lock the key out for a whole cooldown window on top of failing.
      this.sql.exec(
        `INSERT INTO throttle (flow, key, last_attempt) VALUES (?, ?, ?)
         ON CONFLICT (flow, key) DO UPDATE SET last_attempt = excluded.last_attempt`,
        flow,
        key,
        Date.now(),
      );
      return { runId, created: true, status: 'queued' };
    }

    // -------------------------------------------------------------------------
    // report — idempotent by PK; seq bump; fanout; waiter notify on terminal
    // -------------------------------------------------------------------------

    async report(runId: string, report: Report): Promise<void> {
      const exists = this.sql
        .exec(`SELECT 1 AS one FROM runs WHERE run_id = ?`, runId)
        .toArray()[0];
      if (!exists) {
        // Flows must be started via the hub; a report for an unknown run is a
        // producer bug, surfaced loudly but never thrown back at the work.
        console.warn(`FlowHub: report for unknown run ${runId} dropped`);
        return;
      }

      switch (report.kind) {
        case 'unit':
          this.sql.exec(
            `INSERT OR IGNORE INTO units (run_id, step, unit) VALUES (?, ?, ?)`,
            runId,
            report.step,
            report.unit,
          );
          if (report.attempt !== undefined) {
            this.sql.exec(
              `UPDATE steps SET attempt = ? WHERE run_id = ? AND step = ?`,
              report.attempt,
              runId,
              report.step,
            );
          }
          break;
        case 'total':
          this.sql.exec(
            `UPDATE steps SET total = ? WHERE run_id = ? AND step = ?`,
            report.total,
            runId,
            report.step,
          );
          break;
        case 'step':
          this.sql.exec(
            `UPDATE steps SET state = ?, attempt = COALESCE(?, attempt)
             WHERE run_id = ? AND step = ?`,
            report.state,
            report.attempt ?? null,
            runId,
            report.step,
          );
          break;
        case 'status':
          // Output is meaningful ONLY on complete — any other status clears
          // it. A restarted-then-failed run must not keep success-shaped
          // output for joins/getRun to hand out alongside status 'failed'.
          this.sql.exec(
            `UPDATE runs SET status = ?, error = ?, output = ?
             WHERE run_id = ?`,
            report.status,
            report.error ?? null,
            report.status === 'complete' && report.output !== undefined
              ? JSON.stringify(report.output)
              : null,
            runId,
          );
          break;
      }
      this.sql.exec(
        `UPDATE runs SET seq = seq + 1, updated_at = ? WHERE run_id = ?`,
        Date.now(),
        runId,
      );
      this.fanout(runId);

      if (report.kind === 'status' && report.status !== 'running') {
        if (report.status === 'complete') this.warnUnfinished(runId);
        await this.notifyWaiters(runId);
      }
    }

    /** The completeness check: a complete run with non-terminal, non-skipped
     *  steps means the body forgot a declared step (or forgot to skip it). */
    private warnUnfinished(runId: string): void {
      const rows = this.sql
        .exec(
          `SELECT step FROM steps
           WHERE run_id = ? AND state NOT IN ('complete','skipped')
           ORDER BY ord`,
          runId,
        )
        .toArray();
      if (rows.length > 0) {
        console.error(
          `FlowHub: run ${runId} completed with unfinished steps: ` +
            rows.map((r) => r.step as string).join(', '),
        );
      }
    }

    // -------------------------------------------------------------------------
    // reads
    // -------------------------------------------------------------------------

    private rowToRun(row: Record<string, unknown>): RunInfo {
      return {
        runId: row.run_id as string,
        flow: row.flow as string,
        key: row.key as string,
        params: JSON.parse(row.params as string),
        status: row.status as HubRunStatus,
        error: (row.error as string | null) ?? null,
        output: row.output ? JSON.parse(row.output as string) : null,
        createdAt: row.created_at as number,
        updatedAt: row.updated_at as number,
      };
    }

    async getRun(runId: string): Promise<RunInfo | null> {
      const row = this.sql
        .exec(`SELECT * FROM runs WHERE run_id = ?`, runId)
        .toArray()[0];
      if (!row) return null;
      const run = this.rowToRun(row);
      return isActiveStatus(run.status) ? this.reconcile(run) : run;
    }

    async getSnapshot(query: {
      runId?: string;
      flow?: string;
      key?: string;
    }): Promise<Snapshot | null> {
      const runId = query.runId ?? this.latestRunId(query.flow, query.key);
      if (!runId) return null;
      // Same lazy reconcile as getRun: snapshot readers (SSE connects, admin
      // polls) must not see `running` forever after a silent producer death.
      await this.getRun(runId);
      return this.snapshotOf(runId);
    }

    async listRuns(
      opts: { flow?: string; limit?: number } = {},
    ): Promise<RunInfo[]> {
      this.prune();
      const rows = opts.flow
        ? this.sql
            .exec(
              `SELECT * FROM runs WHERE flow = ? ORDER BY created_at DESC LIMIT ?`,
              opts.flow,
              opts.limit ?? 100,
            )
            .toArray()
        : this.sql
            .exec(
              `SELECT * FROM runs ORDER BY created_at DESC LIMIT ?`,
              opts.limit ?? 100,
            )
            .toArray();
      const runs: RunInfo[] = [];
      for (const row of rows) {
        const run = this.rowToRun(row);
        runs.push(isActiveStatus(run.status) ? await this.reconcile(run) : run);
      }
      return runs;
    }

    private latestRunId(flow?: string, key?: string): string | null {
      if (!flow || key === undefined) return null;
      const row = this.sql
        .exec(
          `SELECT run_id FROM runs WHERE flow = ? AND key = ?
           ORDER BY created_at DESC LIMIT 1`,
          flow,
          key,
        )
        .toArray()[0];
      return (row?.run_id as string | undefined) ?? null;
    }

    private snapshotOf(runId: string): Snapshot | null {
      const run = this.sql
        .exec(`SELECT * FROM runs WHERE run_id = ?`, runId)
        .toArray()[0];
      if (!run) return null;
      const stepRows = this.sql
        .exec(
          `SELECT s.step, s.state, s.attempt, s.total,
                  (SELECT COUNT(*) FROM units u
                   WHERE u.run_id = s.run_id AND u.step = s.step) AS current
           FROM steps s WHERE s.run_id = ? ORDER BY s.ord`,
          runId,
        )
        .toArray();
      const steps: Record<string, StepState> = {};
      const order: string[] = [];
      for (const row of stepRows) {
        const step = row.step as string;
        order.push(step);
        steps[step] = {
          state: row.state as StepState['state'],
          attempt: row.attempt as number,
          current: row.current as number,
          total: row.total as number | null,
        };
      }
      // 'unknown' renders as failed — the run is gone either way; the error
      // string preserves the distinction.
      const status = run.status as HubRunStatus;
      return {
        flow: run.flow as string,
        runId,
        status: status === 'unknown' ? 'failed' : status,
        error: (run.error as string | null) ?? null,
        output: run.output ? JSON.parse(run.output as string) : undefined,
        seq: run.seq as number,
        order,
        steps,
      };
    }

    // -------------------------------------------------------------------------
    // lazy reconciler — the exception path for producers that died silently
    // -------------------------------------------------------------------------

    private async reconcile(run: RunInfo): Promise<RunInfo> {
      if (Date.now() - run.updatedAt < RECONCILE_AFTER_MS) return run;
      let next: HubRunStatus;
      let error: string | null = run.error;
      let output: string | null = null;
      try {
        const instance = await this.binding(run.flow).get(run.runId);
        const engine = await instance.status();
        next = fromEngineStatus(engine.status);
        if (engine.error) error = errorMessage(engine.error);
        // The producer's complete report normally carries the output; when
        // the reconciler is the one settling the run, the engine's copy is
        // all there is — joins polling getRun must not see null on success.
        if (next === 'complete' && engine.output !== undefined) {
          try {
            output = JSON.stringify(engine.output);
          } catch {
            // Unserializable output is dropped, same as sanitizeOutput.
          }
        }
      } catch {
        next = 'unknown';
        error = 'Instance no longer known to the Workflows engine';
      }
      // CAS on the old status: a report that landed while we awaited the
      // engine wins over our (older) probe result.
      const cas = this.sql.exec(
        // seq bump included: without it the reconciled status fans out with
        // an unchanged seq and every SSE listener drops the frame. Output
        // follows the round-5 rule: only complete carries one.
        `UPDATE runs SET status = ?, error = ?, output = ?, updated_at = ?, seq = seq + 1
         WHERE run_id = ? AND status = ?`,
        next,
        error,
        output,
        Date.now(),
        run.runId,
        run.status,
      );
      const wrote = cas.rowsWritten > 0;
      // Return DB truth, not the probe: if the CAS lost, a concurrent report
      // already moved the row (possibly to terminal) and answering with the
      // stale probe would let getRun/startAndWatch call a settled run active.
      const row = this.sql
        .exec(`SELECT * FROM runs WHERE run_id = ?`, run.runId)
        .toArray()[0];
      const fresh = row ? this.rowToRun(row) : { ...run, status: next, error };
      // Whoever writes a terminal state announces it; a losing CAS means the
      // winning report() already fanned out and notified.
      if (wrote && terminal(next)) {
        // The reconciler settling a run complete is still a completion — the
        // forgotten-step check applies the same as a producer report.
        if (next === 'complete') this.warnUnfinished(run.runId);
        this.fanout(run.runId);
        await this.notifyWaiters(run.runId);
      }
      return fresh;
    }

    private prune(): void {
      const cutoff = Date.now() - RETENTION_MS;
      const dead = this.sql
        .exec(
          `SELECT run_id FROM runs
           WHERE status NOT IN ('queued','running') AND updated_at < ?`,
          cutoff,
        )
        .toArray()
        .map((r) => r.run_id as string);
      for (const runId of dead) {
        this.sql.exec(`DELETE FROM units WHERE run_id = ?`, runId);
        this.sql.exec(`DELETE FROM steps WHERE run_id = ?`, runId);
        this.sql.exec(`DELETE FROM waiters WHERE child_run_id = ?`, runId);
        this.sql.exec(`DELETE FROM runs WHERE run_id = ?`, runId);
      }
      this.sql.exec(`DELETE FROM throttle WHERE last_attempt < ?`, cutoff);
    }

    // -------------------------------------------------------------------------
    // joins — waiter registration + terminal notification
    // -------------------------------------------------------------------------

    async startAndWatch(
      flow: string,
      params: unknown,
      parent: { instanceId: string; flow: string },
    ): Promise<WatchResult> {
      const res = await this.start(flow, params, { force: true });
      if (res.throttled) throw new Error('unreachable: forced start throttled');
      const run = await this.getRun(res.runId);
      if (!run) {
        return {
          runId: res.runId,
          status: 'unknown',
          error: 'run vanished during start',
          output: null,
        };
      }
      if (terminal(run.status)) {
        return {
          runId: run.runId,
          status: run.status,
          error: run.error,
          output: run.output,
        };
      }
      // Registered BEFORE we answer "still running": either the caller sees a
      // terminal status, or this row exists before the terminal report can
      // arrive — no unobserved-completion gap. The INSERT and the re-read
      // below are one synchronous block, and `run` may be stale (getRun can
      // yield at its engine probe, and a terminal report can land in that
      // window — landing before this INSERT, so its notifyWaiters never saw
      // us). The re-read closes that: any terminalization either shows here,
      // or happens after the waiter row exists.
      this.sql.exec(
        `INSERT OR IGNORE INTO waiters (child_run_id, parent_instance_id, parent_flow)
         VALUES (?, ?, ?)`,
        run.runId,
        parent.instanceId,
        parent.flow,
      );
      const row = this.sql
        .exec(`SELECT * FROM runs WHERE run_id = ?`, run.runId)
        .toArray()[0];
      const fresh = row ? this.rowToRun(row) : run;
      if (terminal(fresh.status)) {
        this.sql.exec(
          `DELETE FROM waiters WHERE child_run_id = ? AND parent_instance_id = ?`,
          run.runId,
          parent.instanceId,
        );
        return {
          runId: run.runId,
          status: fresh.status,
          error: fresh.error,
          output: fresh.output,
        };
      }
      return {
        runId: run.runId,
        status: fresh.status,
        error: null,
        output: null,
      };
    }

    private async notifyWaiters(runId: string): Promise<void> {
      const waiters = this.sql
        .exec(`SELECT * FROM waiters WHERE child_run_id = ?`, runId)
        .toArray();
      if (waiters.length === 0) return;
      const run = await this.getRun(runId);
      if (!run) return;
      for (const waiter of waiters) {
        try {
          const instance = await this.binding(waiter.parent_flow as string).get(
            waiter.parent_instance_id as string,
          );
          await instance.sendEvent({
            type: `flow:${runId}`,
            payload: {
              runId,
              status: run.status,
              error: run.error,
              output: run.output,
            },
          });
        } catch (err) {
          // Best-effort: a parent we can't reach falls back to its own
          // waitForEvent-timeout poll. Drop the row either way — it must not
          // accumulate.
          console.warn(
            `FlowHub: waiter notify failed for parent ${String(
              waiter.parent_instance_id,
            )}`,
            err,
          );
        }
        this.sql.exec(
          `DELETE FROM waiters WHERE child_run_id = ? AND parent_instance_id = ?`,
          runId,
          waiter.parent_instance_id,
        );
      }
    }

    // -------------------------------------------------------------------------
    // SSE — push, not poll: fanout() runs on every report
    // -------------------------------------------------------------------------

    private fanout(runId: string): void {
      const set = this.listeners.get(runId);
      if (!set || set.size === 0) return;
      const snap = this.snapshotOf(runId);
      if (!snap) return;
      const done = snap.status === 'complete' || snap.status === 'failed';
      for (const listener of set) {
        listener.send(snap);
        if (done) listener.close();
      }
      if (done) this.listeners.delete(runId);
    }

    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      // /runs mirrors listRuns() for callers that can only reach the DO over
      // fetch — cross-script DO RPC is unsupported between local dev sessions,
      // so the admin panel reads this route instead.
      if (url.pathname.endsWith('/runs')) {
        // Guarded parse: a junk/negative limit falls back to the default
        // (LIMIT NaN errors; SQLite treats LIMIT -1 as unbounded).
        const limit = Number(url.searchParams.get('limit'));
        const runs = await this.listRuns({
          flow: url.searchParams.get('flow') ?? undefined,
          limit: Number.isInteger(limit) && limit > 0 ? limit : undefined,
        });
        // Each entry carries its current snapshot (a local SELECT per run):
        // the poll is then a complete paint on its own — settled runs get
        // their segment strip without a stream, and a dropped SSE heals on
        // the next poll instead of leaving a stale strip.
        return Response.json({
          runs: runs.map((run) => ({
            ...run,
            snapshot: this.snapshotOf(run.runId),
          })),
        });
      }
      // /start mirrors start() for fetch-only callers (the admin's trigger
      // routes) — same reason as /runs above. Errors surface as a 500 with
      // the message rather than a rejected stub.fetch.
      if (url.pathname.endsWith('/start') && request.method === 'POST') {
        const body = (await request.json()) as {
          flow?: string;
          params?: unknown;
          cooldownMs?: number;
          force?: boolean;
        };
        if (!body.flow) {
          return Response.json({ error: 'flow required' }, { status: 400 });
        }
        try {
          const result = await this.start(body.flow, body.params ?? null, {
            cooldownMs: body.cooldownMs,
            force: body.force,
          });
          return Response.json(result);
        } catch (err) {
          return Response.json({ error: errorMessage(err) }, { status: 500 });
        }
      }
      if (!url.pathname.endsWith('/sse')) {
        return Response.json({ error: 'not found' }, { status: 404 });
      }
      const runId =
        url.searchParams.get('runId') ??
        this.latestRunId(
          url.searchParams.get('flow') ?? undefined,
          url.searchParams.get('key') ?? undefined,
        );
      // The await here is for the 404 check + lazy reconcile side-effect
      // only. The frame actually sent is re-read INSIDE stream start(), in
      // the same synchronous block that registers the listener — this stale
      // copy could miss a report (even a terminal one) landing during the
      // await, and a missed terminal frame is a stream that never closes.
      const probe = runId ? await this.getSnapshot({ runId }) : null;
      if (!runId || !probe) {
        return Response.json({ error: 'run not found' }, { status: 404 });
      }

      const encoder = new TextEncoder();
      // Initialized in start(); populated before the stream is returned.
      let listener!: { send: (s: Snapshot) => void; close: () => void };
      const stream = new ReadableStream({
        start: (controller) => {
          let lastSeq = -1;
          let closed = false;
          listener = {
            send: (s: Snapshot) => {
              if (closed || s.seq <= lastSeq) return;
              lastSeq = s.seq;
              controller.enqueue(
                encoder.encode(`data: ${JSON.stringify(s)}\n\n`),
              );
            },
            close: () => {
              if (closed) return;
              closed = true;
              try {
                controller.close();
              } catch {
                // already closed by the client
              }
            },
          };
          let set = this.listeners.get(runId);
          if (!set) this.listeners.set(runId, (set = new Set()));
          set.add(listener);
          // Full snapshot immediately, read synchronously AFTER registration
          // so no report can slip between the read and the listener existing.
          const current = this.snapshotOf(runId);
          if (!current) {
            listener.close();
            set.delete(listener);
            return;
          }
          listener.send(current);
          if (current.status === 'complete' || current.status === 'failed') {
            listener.close();
            set.delete(listener);
          }
        },
        cancel: () => {
          this.listeners.get(runId)?.delete(listener);
        },
      });
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
        },
      });
    }
  };
}
