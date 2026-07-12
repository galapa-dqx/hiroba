/**
 * Snapshot + report protocol — the wire format between a running flow and the
 * hub, and the state shape the hub fans out to clients.
 *
 * The three invariants that carry everything (docs/flow-framework/progress-design.md):
 *
 *   1. Progress is an absolute snapshot, never a delta — steps replay, and any
 *      delta double-counts the moment one re-runs.
 *   2. The producer never reports `current`. A unit reports only itself
 *      ("unit X done"); `current` is derived as the count of distinct units.
 *      Parallel dispatch completes out of order, so there is no deterministic
 *      ordinal a producer could safely report.
 *   3. Idempotency lives in the primary key (run, step, unit): a replayed
 *      report is a no-op overwrite, not a bug to defend against.
 *
 * `createRunState` below is the reference reducer for these semantics. The
 * FlowHub reimplements them in SQLite (rows + COUNT(*)); the inline harness
 * and the hub's tests both pin behavior against this one.
 */

import type { AnyFlowDef, StepsShape } from './define';

export type RunStatus = 'queued' | 'running' | 'complete' | 'failed';

/** `skipped` is the STORED skip — the run decided not to run this step
 *  (`f.skip`). The other skip ("never got the chance because an earlier step
 *  failed") is view-derived from `pending` + failedIndex; see `segmentView`. */
export type StepRunState =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'skipped';

export type StepState = {
  state: StepRunState;
  /** 0 = never started · 1 = first try · >1 = retry. Engine-attempt derived,
   *  cosmetic (drives the retry badge) — never load-bearing. */
  attempt: number;
  /** Completed units — always derived from distinct unit ids, never written. */
  current: number;
  /** 1 = single · n = known · null = indeterminate (drain). */
  total: number | null;
};

export type Snapshot<
  Name extends string = string,
  S extends StepsShape = StepsShape,
> = {
  flow: Name;
  runId: string;
  status: RunStatus;
  error: string | null;
  /** Terminal output, when the producer chose to ship one (small summaries). */
  output?: unknown;
  /** Monotonic per run — SSE ordering + stale-frame drop on reconnect. */
  seq: number;
  /** Authoritative segment order (= definition insertion order). Shipped so
   *  clients never re-derive order from a hashmap. */
  order: (keyof S & string)[];
  steps: { [K in keyof S]: StepState };
};

export type SnapshotFor<D extends AnyFlowDef> = Snapshot<D['name'], D['steps']>;

// -----------------------------------------------------------------------------
// Reports — producer → hub. Facts only; aggregates are the hub's job.
// -----------------------------------------------------------------------------

export type Report =
  | {
      kind: 'step';
      step: string;
      state: 'running' | 'complete' | 'failed' | 'skipped';
      attempt?: number;
      reason?: string;
    }
  | { kind: 'total'; step: string; total: number | null }
  | { kind: 'unit'; step: string; unit: string; attempt?: number }
  | {
      kind: 'status';
      status: 'running' | 'complete' | 'failed';
      error?: string;
      /** Terminal output of the run, if small enough to travel — joined
       *  parents receive it as the child's result. Keep it a summary, not a
       *  payload: real data belongs in D1. */
      output?: unknown;
    };

/** The tracker's outbound port. The FlowHub implements this over DO RPC; the
 *  inline harness implements it over `createRunState`. Reports are best-effort
 *  from the caller's side — an implementation should not throw for tracking's
 *  sake, and the tracker swallows (logs) anything that does. */
export type FlowReporter = {
  report(runId: string, report: Report): void | Promise<void>;
};

// -----------------------------------------------------------------------------
// Seed + reducer
// -----------------------------------------------------------------------------

/** The full pending step map, seeded EAGERLY at run creation — the bar draws
 *  every segment on frame one, so "not yet started" must be paintable. */
export function seedSnapshot<D extends AnyFlowDef>(
  def: D,
  runId: string,
): SnapshotFor<D> {
  const steps = Object.fromEntries(
    Object.entries(def.steps).map(([key, desc]) => [
      key,
      {
        state: 'pending',
        attempt: 0,
        current: 0,
        total: desc.kind === 'units' ? null : 1,
      } satisfies StepState,
    ]),
  );
  return {
    flow: def.name,
    runId,
    status: 'queued',
    error: null,
    seq: 0,
    order: Object.keys(def.steps),
    steps,
  } as SnapshotFor<D>;
}

/**
 * Reference in-memory run state: seed once, apply reports, read snapshots.
 * Unit idempotency is a Set (the hub's PRIMARY KEY); `current` is its size
 * (the hub's COUNT(*)). Unknown step names are ignored with the same shrug the
 * hub gives them — a report for an undeclared step is a producer bug surfaced
 * by `unfinishedSteps`, not a crash.
 */
export function createRunState<D extends AnyFlowDef>(def: D, runId: string) {
  const snapshot = seedSnapshot(def, runId);
  const units = new Map<string, Set<string>>();

  const apply = (report: Report): void => {
    switch (report.kind) {
      case 'step': {
        const step = snapshot.steps[report.step as keyof typeof snapshot.steps];
        if (!step) break;
        step.state = report.state;
        if (report.attempt !== undefined) step.attempt = report.attempt;
        break;
      }
      case 'total': {
        const step = snapshot.steps[report.step as keyof typeof snapshot.steps];
        if (!step) break;
        step.total = report.total;
        break;
      }
      case 'unit': {
        const step = snapshot.steps[report.step as keyof typeof snapshot.steps];
        if (!step) break;
        let set = units.get(report.step);
        if (!set) units.set(report.step, (set = new Set()));
        set.add(report.unit);
        step.current = set.size;
        if (report.attempt !== undefined) step.attempt = report.attempt;
        break;
      }
      case 'status': {
        snapshot.status = report.status;
        snapshot.error = report.error ?? null;
        // Output is meaningful only on complete; any other status clears it
        // (mirrors the hub — a restarted-then-failed run must not keep
        // success-shaped output).
        snapshot.output =
          report.status === 'complete' ? report.output : undefined;
        break;
      }
    }
    snapshot.seq += 1;
  };

  return {
    apply,
    /** A defensive copy — safe to retain across further applies. */
    snapshot: (): SnapshotFor<D> => structuredClone(snapshot),
    /** Steps neither terminal nor skipped. Non-empty on a `complete` run means
     *  the body forgot a declared step (or forgot to `skip` it) — the hub logs
     *  this loudly instead of leaving a forever-pending segment. */
    unfinishedSteps: (): string[] =>
      snapshot.order.filter((key) => {
        const s = snapshot.steps[key].state;
        return s !== 'complete' && s !== 'skipped';
      }),
  };
}

// -----------------------------------------------------------------------------
// Render helpers — the one place task/units/phase branching would otherwise
// creep back in. Everything renders off `total`.
// -----------------------------------------------------------------------------

/** null = no counter (single unit) · `5…` = indeterminate · `5/10` = known. */
export function renderCount(step: StepState): string | null {
  if (step.total === 1) return null;
  if (step.total === null) return `${step.current}…`;
  return `${step.current}/${step.total}`;
}

/** Stored states pass through; `not-reached` is the view-derived "never got
 *  the chance" for pending steps trailing a failure. Distinct from stored
 *  `skipped` ("the run chose not to"), which is ground truth. */
export type SegmentView = StepRunState | 'not-reached';

export function segmentView(
  step: StepState,
  index: number,
  failedIndex: number,
): SegmentView {
  if (step.state !== 'pending') return step.state;
  return failedIndex >= 0 && index > failedIndex ? 'not-reached' : 'pending';
}
