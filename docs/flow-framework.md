# Flow framework — naming, layout & design record

> Decision record for the flow-framework groundwork (tracked internally as
> DQX-16). Every subsequent PR in the unified-workflow-framework effort
> references this file instead of re-deciding. The full design rationale
> lives in [flow-framework/progress-design.md](flow-framework/progress-design.md);
> the API sketches in [flow-framework/](flow-framework/).

## The object model

Three nested objects, each with exactly one writer. The `Report` union is
literally the write API for the hub's three tables:

| Level    | Table   | Report kinds    | What it is                                                                                                                                    |
| -------- | ------- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **Run**  | `runs`  | `status`        | One execution of a flow (= one workflow instance). `queued → running → complete/failed` — the run's lifecycle.                                |
| **Step** | `steps` | `step`, `total` | One declared segment (from `defineFlow`, seeded `pending` before anything executes). `pending → running → complete/failed/skipped` + `total`. |
| **Unit** | `units` | `unit`          | The atom of completion inside a step — one row per finished unit. A unit has no state; the row existing IS the fact. `current` = COUNT(\*).   |

A run has N steps (declared ahead of execution); a step has N units
(discovered at runtime). A plain `step()`/`phase()` is just a step whose unit
set is exactly `{'1'}` — task-vs-loop is a cardinality, not a kind.

Roles, along the other axis:

- **Producer** — the running flow body, via the tracker. Emits only facts it
  directly witnessed (`step`/`total`/`unit`); never aggregates (`current`),
  never conclusions. The one exception: the `FlowEntrypoint` shell emits the
  two run-level `status` reports, because only it witnesses "the body
  resolved/threw".
- **Hub** — store/deriver: applies reports idempotently, derives `current`,
  stamps `seq`, fans out snapshots. Adds no facts of its own (except the lazy
  reconciler back-filling `status` for a run whose producer died mid-sentence).
- **Consumer** — sees only `Snapshot`; never touches `Report`.

Why `step: failed` and `status: failed` are deliberately independent: a step
can flap `failed → running → complete` across engine retries while the run is
fine, and when the run does die, later steps stay honestly `pending` (the view
derives `not-reached`). **Key "this run is dead" off `status`, never off a
segment being red** — otherwise a recovered run flashes a spuriously dead bar.

## Vocabulary (settled)

| Name             | What it is                                                                                                                                                                                                         |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **flow**         | A workflow definition + its orchestration, on the framework. "Workflow" means the raw Cloudflare primitive; "flow" means ours.                                                                                     |
| `defineFlow`     | Definition-as-value: name, `key(params)` dedup identity, shape-only step map (`step()` / `units()` / `phase()` descriptors). Composable via object spreads; insertion order is segment order.                      |
| `Flow<S>`        | The per-run tracker handed to a flow body. Primitives: `step`, `phase`, `map`, `drain`, `skip`, `open`, `join` / `joinSettled`. Conventionally bound to `f`.                                                       |
| `PhaseStep`      | The scoped engine step inside a `phase` body: name-prefixed `do` / `sleep` / `waitForEvent`, plus `poll` (the sleep/check/budget loop).                                                                            |
| `FlowEntrypoint` | Base class over `WorkflowEntrypoint`: builds the tracker, terminal status reporting, optional `onFailure` cleanup step, rethrows untouched.                                                                        |
| `FlowHub`        | ONE Durable Object, ONE SQLite database, all control-plane state: runs / steps / units / waiters / throttle. Start (lock-free dedup-with-attach), report (idempotent + push SSE), runs listing, join notification. |
| `runFlowInline`  | In-memory harness: fake engine step + collecting reporter. The fast orchestration-test tier.                                                                                                                       |

## Package layout (settled)

- **`packages/flow`** — the framework. Generic: knows nothing about hiroba's domain.
  Exports everything in the table above plus snapshot types and render helpers.
- **`packages/flows`** — hiroba's flow _definitions only_ (`ArticleFlow`,
  `PlayguideFlow`, `BannerFlow`, …). Thin on purpose: importable by `apps/admin`
  for typed snapshots without dragging in step code, and keeps `@hiroba/shared`
  from accreting. Flow _bodies_ and step functions stay in `apps/workflow`.
- The def-name → workflow-binding map is built where the hub is mounted
  (`apps/workflow/src/index.ts`) and nowhere else — the one string-dispatch
  boundary.

## Core invariants (from the design phase — see progress-design.md for why)

1. **Progress is absolute, never a delta.** Steps replay; deltas double-count.
2. **The producer never reports `current`** — it reports "unit X done"; the hub
   derives `current = COUNT(*)`. Idempotency lives in the PRIMARY KEY
   `(run_id, step, unit)`.
3. **State crosses step boundaries only via step returns or D1 — never
   closures.** Step _returns_ replay; step _bodies_ don't. `map`/`drain` collect
   and return memoized results for exactly this reason.
4. **Errors rethrow untouched.** No `NonRetryableError` wrapping as a tracking
   side effect; no continue-after-error — a failed step fails the run.
5. **Two "skipped" states.** Stored `skipped` = the run _decided_ not to run a
   step (ground truth, producer-reported via `f.skip`). View-derived skipped =
   pending steps trailing a failure (render-side only, never stored).
6. **The framework observes and names; the engine executes.** Every primitive
   bottoms out in real `step.do` / `step.sleep` / `step.waitForEvent` with
   deterministic names (`translate/batch/check-3`). Delete the hub and the
   flows still run correctly — blind, but correct.
7. **Hub start is lock-free.** Self-generated run ids so the SQLite INSERT
   (partial unique index on active `(flow, key)`) precedes the engine
   `create({id})`. No `blockConcurrencyWhile`; the index carries correctness.

## Migration strategy

Parallel **infrastructure**, serial per-workflow cutover — never double-run one
workflow on both systems. Each port PR: class → framework, trigger →
`hub.start`, consumers → hub endpoints, delete the old coordinator-DO
handler. **`steps/` modules never change** — ports touch orchestration only.

Order (each PR proves one new capability): foundations dark — framework core,
hub, dark mount (DQX-17–19) → Banner → Glossary → Titles → News-backfill
(DQX-20–23) → Playguide split → Article → dissolve the coordinator DO
(DQX-24–26) → image child flows joined via `mapJoin`, glossary re-triggers
upgraded to joins (DQX-27) — all landed. Still parked: retiring
`computeSnapshot` (DQX-28).

Operational note: in-flight instances error when step names change on deploy.
Small flows: tolerate-and-retrigger. Article port: quiet window (instances can
sleep 24h in batch translate).

## Artifacts

- [flow-framework/progress-design.md](flow-framework/progress-design.md) —
  design rationale (invariants and the reasoning behind them; reconstructed
  from the original design conversation).

The pre-implementation type sketches (`sketch-progress-v3.ts`,
`sketch-usage-v2.ts`) were removed once the framework landed in
`packages/flow`; see git history if you need them.
