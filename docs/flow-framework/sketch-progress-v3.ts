// =============================================================================
// progress-v3.ts — progress-tracking layer for the (since-dissolved) workflow
// coordinator DO
//
// Changes from v2:
//   • No registry. Each workflow is a standalone value: `workflow({ name, steps })`.
//     Producer/consumer/DO all take the DEFINITION, never a name→def lookup.
//   • Steps are an OBJECT keyed by id. Insertion order (ES2015, non-integer keys)
//     IS the segment order — no tuple, no `as const`. Keyed types fall out directly.
//   • Parallel work is Promise.all only. Best-effort / onError removed; a thrown
//     unit fails the step like any other. `failed` count dropped (was only there
//     to render partial failure, which can't happen under all-or-nothing).
//
// Unchanged invariants (why it's replay-safe):
//   1. Producer never reports `current`. It reports "unit X done." The DO derives
//      current = COUNT(*) of completed unit rows.
//   2. Unit reports are idempotent by PRIMARY KEY (run, step, unit): a replay
//      re-inserts the same row (no-op); out-of-order completion doesn't matter.
// =============================================================================


// -----------------------------------------------------------------------------
// 1. Descriptor + definition-as-value
// -----------------------------------------------------------------------------

/** `multi` only decides the SEED total (1 vs null). No task/loop kind past here. */
interface StepDesc { readonly multi: boolean }

const task = (): StepDesc => ({ multi: false });  // total = 1    -> renders plain
const loop = (): StepDesc => ({ multi: true });   // total = null -> renders counter

type StepsShape = Record<string, StepDesc>;

interface WorkflowDef<Name extends string, S extends StepsShape> {
  readonly name: Name;
  readonly steps: S;
}

/** Bundles identity + shape into one importable value. `const` generics capture
 *  the literal name and the literal step keys (in insertion order). Throws at
 *  module-load if a step id is an integer-index string, which would reorder
 *  ahead of declaration order and silently scramble the segmented bar. */
function workflow<const Name extends string, const S extends StepsShape>(
  def: { name: Name; steps: S },
): WorkflowDef<Name, S> {
  for (const id of Object.keys(def.steps)) {
    if (String(Number(id)) === id) {
      throw new Error(
        `Step id "${id}" is numeric — integer-index keys reorder ahead of ` +
        `insertion order and break segment order. Use a non-numeric id.`,
      );
    }
  }
  return def;
}

// Derived types — object keys give us keyed access for free (no tuple remap).
type StepsOf<W> = W extends WorkflowDef<string, infer S> ? S : never;
type StepId<W>  = keyof StepsOf<W> & string;          // union of step ids


// -----------------------------------------------------------------------------
// 2. Example definitions — export the VALUE; consumers import it directly
// -----------------------------------------------------------------------------

const ImportOrders = workflow({
  name: 'importOrders',
  steps: {
    validate: task(),   // 1 unit
    fetch:    loop(),   // pool/drain: page numbers 'til empty (total stays null)
    write:    loop(),   // each/map: total known once we have the orders array
  },
});

const SyncInventory = workflow({
  name: 'syncInventory',
  steps: { snapshot: task(), reconcile: loop() },
});


// -----------------------------------------------------------------------------
// 3. State model — one uniform shape per step
// -----------------------------------------------------------------------------

type RunState  = 'pending' | 'running' | 'complete' | 'failed';
type RunStatus = 'running' | 'complete' | 'failed';

interface StepState {
  state:   RunState;
  attempt: number;        // 0 = pending · 1 = first try · >1 = retry (from ctx.attempt)
  current: number;        // completed units = COUNT(*) — never written by producer
  total:   number | null; // 1 = single · n = known · null = indeterminate (drain pool)
}

interface Snapshot<Name extends string, S extends StepsShape> {
  type:   Name;
  status: RunStatus;
  seq:    number;                    // monotonic — SSE ordering + stale-frame drop
  order:  (keyof S)[];               // authoritative segment order (= insertion order)
  steps:  { [K in keyof S]: StepState };
}

type SnapshotFor<W> =
  W extends WorkflowDef<infer N, infer S> ? Snapshot<N, S> : never;

/** The one render rule that replaces task/loop branching. */
function renderCount(s: StepState): string | null {
  if (s.total === 1) return null;               // single unit — no counter
  if (s.total === null) return `${s.current}…`; // indeterminate
  return `${s.current}/${s.total}`;             // known denominator
}


// -----------------------------------------------------------------------------
// 4. Wire format — Workflow -> DO
// -----------------------------------------------------------------------------

type Report =
  | { kind: 'unit';   step: string; unit: string; state: 'complete'; attempt: number }
  | { kind: 'total';  step: string; total: number | null }
  | { kind: 'step';   step: string; state: 'running' | 'complete' | 'failed' }
  | { kind: 'status'; status: RunStatus };
// Note: no 'failed' unit report — under Promise.all a thrown unit rejects the
// step, which surfaces as { kind:'step', state:'failed' } + { kind:'status' }.


// -----------------------------------------------------------------------------
// 5. Producer API
// -----------------------------------------------------------------------------

/** Subset of CF's step ctx. `attempt` is engine-owned → replay-safe for free.
 *  Pin @cloudflare/workers-types; re-verify this shape on upgrade. */
interface WorkflowStepCtx {
  readonly attempt: number;  // 1-indexed
  readonly name: string;
  readonly count: number;
}

interface Tracker<S extends StepsShape> {
  /** Single-unit step (task). Reports step running → runs one durable step.do →
   *  on success reports unit + step complete; on throw reports step failed and
   *  RETHROWS THE ORIGINAL ERROR untouched (engine owns retry/terminal). */
  run<K extends keyof S, T>(key: K, fn: (ctx: WorkflowStepCtx) => Promise<T>): Promise<T>;

  /** Known set — YOU dispatch (sequential for-loop, or Promise.all). */
  each<K extends keyof S>(key: K): EachHandle;

  /** Unknown stream — the pool dispatches at bounded concurrency until drained. */
  pool<K extends keyof S>(key: K, opts: PoolOptions): PoolHandle;
}

interface EachHandle {
  expect(total: number | null): Promise<void>;   // set denominator once known
  unit<T>(id: string | number, fn: (ctx: WorkflowStepCtx) => Promise<T>): Promise<T>;
  done(): Promise<void>;
  // Parallel: await Promise.all(items.map(x => h.unit(x.id, fn))). A rejection
  // rejects the step. In-flight losers aren't cancelled — they run to completion
  // and memoize, so the engine's step retry re-runs only the unfinished units.
}

interface PoolOptions { concurrency: number }

/** Worker returns this to signal "empty page — stop dispatching." Sound only
 *  because emptiness is monotonic (no interior holes): in-flight overrun past
 *  the empty page is harmless. The stop page reports no unit (probe, not work),
 *  so it never counts. done() — not arithmetic — completes the step (total null). */
const DRAIN_STOP: unique symbol = Symbol('DRAIN_STOP');
type DrainResult<T> = T | typeof DRAIN_STOP;

interface PoolHandle {
  drain<T>(worker: (page: number, ctx: WorkflowStepCtx) => Promise<DrainResult<T>>): Promise<void>;
  done(): Promise<void>;
}

/** Entry point inside a Workflow's run(). Typed off the definition value. */
declare function track<W extends WorkflowDef<string, StepsShape>>(
  step: unknown /* WorkflowStep */,
  runCtx: { env: unknown; runId: string },
  def: W,
): Tracker<StepsOf<W>>;


// -----------------------------------------------------------------------------
// 6. Consumer API — pass the definition value; snapshot type is derived from it
// -----------------------------------------------------------------------------

/** `def` carries both the name (runtime: assert against frame.type) and the step
 *  shape (compile time: types snap.steps.validate etc). The SSE still routes by
 *  runId — the def is not a lookup, just the type + a name to sanity-check. */
declare function subscribe<W extends WorkflowDef<string, StepsShape>>(
  def: W,
  runId: string,
  onFrame: (snap: SnapshotFor<W>) => void,
): () => void;

type SegmentView = RunState | 'skipped';

function segmentView(step: StepState, index: number, failedIndex: number): SegmentView {
  if (step.state !== 'pending') return step.state;
  return failedIndex >= 0 && index > failedIndex ? 'skipped' : 'pending';
}


// -----------------------------------------------------------------------------
// 7. Seed — DO writes the full pending map at run creation, from the definition
// -----------------------------------------------------------------------------

function seedState<W extends WorkflowDef<string, StepsShape>>(def: W): SnapshotFor<W> {
  const steps = Object.fromEntries(
    Object.entries(def.steps).map(([k, d]) => [k, {
      state: 'pending' as RunState,
      attempt: 0,
      current: 0,
      total: d.multi ? null : 1,
    }]),
  );
  return {
    type: def.name,
    status: 'running',
    seq: 0,
    order: Object.keys(def.steps),
    steps,
  } as SnapshotFor<W>;
}


// -----------------------------------------------------------------------------
// 8. Durable Object — units are ROWS; current is COUNT(*), not stored
// -----------------------------------------------------------------------------

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS runs (
    run_id TEXT PRIMARY KEY, type TEXT NOT NULL, status TEXT NOT NULL,
    seq INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS steps (
    run_id TEXT NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 0, total INTEGER, ord INTEGER NOT NULL,
    PRIMARY KEY (run_id, step)
  );
  CREATE TABLE IF NOT EXISTS units (
    run_id TEXT NOT NULL, step TEXT NOT NULL, unit TEXT NOT NULL,
    state TEXT NOT NULL,                 -- 'complete'
    PRIMARY KEY (run_id, step, unit)     -- replay dedup, for free
  );
`;

/*
  report(runId, r: Report) {
    switch (r.kind) {
      case 'unit':                                  // idempotent by PK
        sql.exec(`INSERT OR REPLACE INTO units (run_id,step,unit,state) VALUES (?,?,?,?)`,
                 runId, r.step, r.unit, r.state);
        sql.exec(`UPDATE steps SET attempt=? WHERE run_id=? AND step=?`, r.attempt, runId, r.step);
        break;
      case 'total':  sql.exec(`UPDATE steps SET total=? WHERE run_id=? AND step=?`, r.total, runId, r.step); break;
      case 'step':   sql.exec(`UPDATE steps SET state=? WHERE run_id=? AND step=?`, r.state, runId, r.step); break;
      case 'status': sql.exec(`UPDATE runs  SET status=? WHERE run_id=?`, r.status, runId); break;
    }
    sql.exec(`UPDATE runs SET seq = seq + 1 WHERE run_id=?`, runId);
    this.fanout(runId);   // build snapshot, push to SSE listeners past their last seq
  }

  snapshot(runId) {
    // current = COUNT(*) of completed units per step, joined onto steps meta,
    // ordered by `ord` → Snapshot { type, status, seq, order, steps }.
  }
*/


// -----------------------------------------------------------------------------
// 9. Usage
// -----------------------------------------------------------------------------

/*
// --- Workflow ---------------------------------------------------------------
export class ImportOrdersWorkflow extends WorkflowEntrypoint<Env, ImportParams> {
  async run(event, step) {
    const p = track(step, { env: this.env, runId: event.instanceId }, ImportOrders);

    const src = await p.run('validate', () => validateInput(event.payload));

    const fetch = p.pool('fetch', { concurrency: 8 });
    const orders: Order[] = [];
    await fetch.drain(async (page, ctx) => {
      const res = await fetchOrderPage(page, ctx);   // page = 1,2,3,... (pool-owned)
      if (res.items.length === 0) return DRAIN_STOP; // empty → stop dispatching
      orders.push(...res.items);
      return res.items.length;
    });
    await fetch.done();

    const write = p.each('write');
    await write.expect(orders.length);
    await Promise.all(orders.map(o => write.unit(o.id, () => writeOrder(o))));
    await write.done();

    return { imported: orders.length };
  }
}

// --- Client -----------------------------------------------------------------
function ProgressBar({ runId }: { runId: string }) {
  const [snap, setSnap] = useState<SnapshotFor<typeof ImportOrders> | null>(null);
  useEffect(() => subscribe(ImportOrders, runId, setSnap), [runId]);
  if (!snap) return null;

  const failedIndex = snap.order.findIndex(k => snap.steps[k].state === 'failed');
  return (
    <div className="segmented-bar">
      {snap.order.map((key, i) => {
        const s = snap.steps[key];
        const view = segmentView(s, i, failedIndex);
        const count = renderCount(s);
        return (
          <Segment key={String(key)} state={view}>
            {count && <span>{count}</span>}
            {s.state === 'running' && s.attempt > 1 && <Badge>retry {s.attempt}</Badge>}
          </Segment>
        );
      })}
    </div>
  );
}
*/


export {
  workflow, task, loop, renderCount, segmentView, seedState, track, subscribe,
  DRAIN_STOP, SCHEMA, ImportOrders, SyncInventory,
  type StepDesc, type StepsShape, type WorkflowDef, type StepsOf, type StepId,
  type RunState, type RunStatus, type StepState, type Snapshot, type SnapshotFor,
  type Report, type Tracker, type EachHandle, type PoolHandle, type PoolOptions,
  type DrainResult, type WorkflowStepCtx, type SegmentView,
};
