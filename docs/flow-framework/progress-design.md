# Workflow Progress Tracking — Design Notes

A TypeScript layer over Cloudflare Workflows that lets the web app track run status
via SSE, with a `WorkflowManager` Durable Object as the store and fan-out point.

> Reconstructed from the design conversation. Captures decisions **and their
> rationale** — the rationale is the part that's expensive to re-derive.
> Companion file: `progress-v3.ts` (the type sketch).

---

## The problem

- Multiple workflows, each with its own steps.
- Client needs live status per run ID over SSE.
- Admin UI has a **segmented/stepped progress bar**; other UIs use progressive disclosure.
- Many workflows paginate; some **don't know the page count up front**.
- Must limit duplicated code and stay type-safe.

---

## Core invariants

These three carry the whole design. Everything else follows.

### 1. Progress is an absolute snapshot, never a delta

Cloudflare Workflow steps **replay on retry**. Any delta API (`increment()`,
`emit('page-done')`) double-counts the moment a step re-runs. Reporting *absolute
truth* ("current = 5", "total = 10") makes replay a harmless overwrite, so
last-write-wins is automatically correct.

This is the decision that makes storage, updates, and SSE all fall into place.

### 2. The producer never reports `current`

A unit reports **only itself**: "unit X is done." The DO derives
`current = COUNT(*)` of completed unit rows.

Why this is *required*, not just tidier: with sequential iteration a `++n` counter
happens to be replay-safe (deterministic re-execution rebuilds it). **Parallel
dispatch breaks that** — completions land out of order, so there's no deterministic
ordinal to rebuild, and reporting "index of the one I just finished" makes `current`
flap (7, then 3, then 9…) under last-write-wins.

### 3. Idempotency lives in the PRIMARY KEY

`PRIMARY KEY (run_id, step, unit)`. A replayed unit re-inserts the same row → no-op.
Out-of-order parallel completion → don't care, rows aren't ordered. No `Set.add`
dedup logic, no application-level membership checks.

---

## Decisions

### The descriptor stays (it's load-bearing)

**Why not derive steps from the code?** Two things a `p.step('validate', …)` call
buried in a function body cannot give you:

1. **Types don't come from function bodies.** The client importing
   `snap.steps.validate` autocomplete needs the keys to exist as a *type*,
   independent of execution.
2. **The bar needs the step set before the steps run.** You can't render "3 of 7"
   if you only learn there are 7 by executing all 7.

→ Progressive-disclosure UIs *could* go declaration-free. The **segmented bar cannot**.
Since the admin UI has one, the descriptor stays. The wrapper's job isn't to delete
the declaration — it's to make it **write-once** and generate the runner from it.

### Merge task and loop → a step is a set of units

Not "collapse two types," but a reframe: **a step is a set of units; a unit is the
thing that completes.**

| | units | `total` | renders |
|---|---|---|---|
| task | 1 (the step itself) | `1` | plain |
| each / map | N, known at runtime | `n` | `5/10` |
| pool / drain | N, unknown | `null` | `5…` |

task-vs-loop stops being a *kind* and becomes a *cardinality*. One `StepState`
shape, no discriminant, one render rule keyed off `total`.

### `pending` is a real state, seeded eagerly

The bar draws every segment on frame one, so "not yet started" must be paintable,
not absent. The DO seeds the **full** step map from the definition **at run
creation** — not lazily on first report. Seed lazily and an admin opening the page
early sees a half-empty bar filling in structurally, which reads as broken.

### `skipped` is a *view* state, never stored

When a step fails, trailing steps are still `pending` — they genuinely never ran.
That's ground truth; keep it in storage. The render derives `skipped` from
`pending` + a known `failedIndex`:

```ts
if (step.state !== 'pending') return step.state;
return failedIndex >= 0 && index > failedIndex ? 'skipped' : 'pending';
```

Writing `skipped` into the DO would be storage inventing a state to serve one
render — and the next consumer would have to reverse-engineer it back. Bonus: the
DO needs **no cleanup pass on failure**. Storage stays monotonic and dumb.

### Retries: observe, never manage

CF retries `step.do` automatically (default ~3 attempts, exponential backoff;
per-step `WorkflowStepConfig` to override; `NonRetryableError` to stop).

The wrapper's catch **reports `failed` and rethrows the original error untouched**.
Never wrap in `NonRetryableError` — that silently converts a transient failure into
a permanent one as a *side effect of tracking*.

`ctx.attempt` (engine-provided, 1-indexed) gives the retry badge with zero added
state — it's the engine's count, absolute, replay-safe for free. Render rule:
`state === 'running' && attempt > 1` → "Fetching… (retry 2)". Quiet runs stay quiet.

**Corollary:** a step can flap `failed → running → complete` across retries. Key
"this run is dead" off top-level `status`, **never** off an individual segment being
`failed` — otherwise a recovered run shows a spuriously red bar.

### Units are SQLite rows, not a Set in a blob

`current` becomes a read (`COUNT(*)`), never a write. This also kills the storage-cost
worry: 50k units = 50k rows, counted through an index, and each report is an **O(1)
write regardless of loop size** — versus rewriting a 50k-element JSON blob on every
single completion.

Start with `COUNT(*)` per report (indexed aggregate over one run). Denormalize a
`current` column only if fan-out profiling says it's hot — the count removes an
entire class of "counter drifted from reality" bug.

### Parallelism: `Promise.all` only (best-effort dropped)

Best-effort forced the DO to answer "what's the state when 48 passed and 1 failed?"
— a threshold policy, a `failed` count in state, a partial-failure render.
`Promise.all` makes it binary: any unit throws → step throws → engine retries or
fails the instance. Same failure path as every other step.

Dropped as a result: `onError`, `'continue'` semantics, and the `failed` count.

**The one sharp edge, which is actually a feature:** `Promise.all` rejection is
eager but **in-flight losers aren't cancelled** (JS can't cancel a promise). They run
to completion and **memoize their `step.do` results** — so the engine's retry of the
step re-runs only the units that hadn't finished. Don't "fix" this by trying to
cancel them.

### The drain pool (indeterminate pagination)

Pagination here is **page numbers until an empty page** — there's no cursor. That
matters: with a cursor, pull K+1 needs K's output, so advancement is serial and
must itself be a durable step. With page numbers, the next unit is `n+1` computed
from nothing. **No producer, no durable pull, no discovery phase.**

```ts
const fetch = p.pool('fetch', { concurrency: 8 });
await fetch.drain(async (page, ctx) => {
  const res = await fetchPage(page, ctx);        // page = 1,2,3,… (pool-owned)
  if (res.items.length === 0) return DRAIN_STOP; // empty → stop dispatching
  await handle(res.items);
  return res.items.length;
});
await fetch.done();
```

Mechanics that make it correct:

- **The pool owns the page counter AND the stop flag** — not the workers. A single
  dispatch loop does *claim next page number → check flag → spawn*. If each worker
  checked the flag, two could both see "not stopped" and both grab a page
  (check-then-act gap). DOs are serial, so keeping claim+check in one loop closes it
  for free.
- **"Stop" means stop *dispatching*, not cancel.** With concurrency 8, when page 5
  hits the sentinel, pages 6–12 are already in flight. They finish (harmlessly
  empty). `drain` resolves when the last one settles. Overrun is bounded by
  `concurrency`.
- **The sentinel page reports NO unit** — it was the probe that found the end, not
  real work. So `current` = 4 (pages with data), not 5. The stop signal and the
  completion report are different channels.
- **`done()` completes the step, not arithmetic.** `current === total` can never fire
  when `total` is `null`. This is the one place indeterminate needs explicit handling.
- A worker **throw** shares the same "stop dispatching" path as `DRAIN_STOP`; they
  differ only in whether `drain` resolves or rejects.

**Soundness precondition: emptiness is monotonic.** Once a page is empty, every later
page is empty. Confirmed true for these endpoints — no interior holes. If that ever
changes, first-empty is unsound (you'd stop at a hole) and the condition must become
"N consecutive empties" or a real end-signal from the API.

### No registry — the definition IS the value

`workflow({ name, steps })` is a standalone importable value. The registry was only
buying a *name*, and the name belongs on the definition.

Runs route to their DO by **`runId`, not by type** — type never routes anything. So
the name's only jobs are tagging the snapshot and letting producer/consumer refer to
the workflow. Both are done by the def itself:

- Producer: `track(step, ctx, ImportOrders)`
- Consumer: `subscribe(ImportOrders, runId, cb)` — imports the value, no string key
  to typo. The def does double duty: compile-time it carries the step shape that
  types `snap.steps`; runtime it carries `name` to assert `frame.type === def.name`.
- DO seed: `create(ImportOrders, runId)`

The generic (data-driven) run viewer needs **neither** the registry nor the def — the
uniform snapshot already carries `order` + `StepState`, which is everything it renders.

A name→def map legitimately reappears **only** at a string-dispatch boundary (e.g.
`POST /runs/:typeName`). Build it *locally at that endpoint*; don't hang the type
system off it.

### Steps stay an object (not a tuple)

Considered an array for explicit ordering. Objects win: ES2015 guarantees insertion
order for **non-integer string keys**, so declaration order *is* segment order, and
keyed types (`snap.steps.validate`) fall out with no tuple→object remapping.

**Guard:** `workflow()` throws at module-load if a step id is a canonical
integer-index string (`"0"`, `"42"`) — those reorder ahead of insertion order and
would silently scramble the bar. Real ids never trip it.

Also ship `order: (keyof S)[]` in the snapshot rather than letting the client
re-derive order from the hashmap — cheap insurance against reshuffling on reconnect.

---

## Wire / storage shape

```ts
interface StepState {
  state:   'pending' | 'running' | 'complete' | 'failed';
  attempt: number;         // 0 = pending · 1 = first try · >1 = retry
  current: number;         // COUNT(*) of completed units — never producer-written
  total:   number | null;  // 1 = single · n = known · null = indeterminate
}
```

```sql
runs  (run_id PK, type, status, seq)
steps (run_id, step, state, attempt, total, ord, PRIMARY KEY (run_id, step))
units (run_id, step, unit, state, PRIMARY KEY (run_id, step, unit))  -- replay dedup
```

`seq` is monotonic → SSE ordering + drop stale frames on reconnect. On connect: send
the full snapshot, then snapshots-on-change gated by `seq`.

**Types are tight at the ends, loose in the middle — on purpose.** The producer knows
its def; the consumer asserts its def; the DO multiplexes every run type as rows and
sees the loose `Report` union. That's the right shape for a DO you don't want to debug
under load.

---

## Open threads

- **Collapse `each` and `pool`?** Is `Promise.all` just `drain` with unlimited
  concurrency? Nearly — but `each` works a set you already hold (you own iteration,
  count known); `pool` drains a stream you can't measure (pool owns iteration, count
  unknown, sentinel-terminated). Unlimited-concurrency `drain` *could* express the
  parallel-map case, but only by feeding a known collection through a
  page-number/sentinel protocol built for the unknown case — inverting who owns the
  loop for no benefit. Question: can one surface serve both without making the common
  in-memory case awkward?
- **Unit id stability.** `each().unit(id, …)` ids must be stable across replays. Array
  index is a trap; use a real domain id.
- **Step-count ceiling.** Each drain page is its own `step.do`. Workers Paid caps at
  10k steps (25k configurable). Long streams could approach it → chunk the drain.
  Doesn't change any types.
- **Platform churn.** Workflows APIs/limits move. Pin `wrangler` + types; re-verify
  the `ctx` shape (esp. `ctx.attempt`) on upgrade. Known bug: `NonRetryableError`'s
  message may not surface cleanly in the instance error — the plain-`Error` path
  preserves it.
