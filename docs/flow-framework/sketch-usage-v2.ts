// =============================================================================
// usage-v2.ts — the progress-v3 layer applied to hiroba's REAL flows.
//
// New over progress-v3 / usage.ts:
//   • defineFlow composition — step fragments spread into definitions in
//     insertion order; shared helpers are typed against the *fragment* they
//     need, so flows share bodies structurally (ArticleFlow ⊃ PlayguideFlow).
//   • phase() — one logical step (one bar segment) wrapping many engine steps.
//     PhaseStep.poll() subsumes the sleep/check/terminal/budget loop, which
//     deletes the batch-translate dance from the workflow body.
//   • skip() — STORED, intentional "this run decided not to run this step"
//     (banner early-exit). Distinct from the design doc's view-derived skip
//     (pending steps trailing a failure), which stays render-side. Two
//     different facts: "chose not to" is ground truth and belongs in storage;
//     "never got the chance" is a consequence of failedIndex and does not.
//   • map()/drain() COLLECT AND RETURN the memoized step results. State
//     crosses step boundaries only via step returns or D1 — never closures.
//     (Fixes the orders.push replay bug in usage.ts: on resume, completed
//     steps memoize and their closures never run, so a closure-accumulated
//     array silently loses every already-done unit.)
//   • join()/joinSettled() — start-or-attach ANOTHER flow via the hub and
//     await its result as a step. Deduped by the child def's key, so many
//     parents share one child run. join throws on child failure (child is a
//     prerequisite); joinSettled returns the terminal status (child is
//     best-effort — the images-degrade-don't-block policy).
// =============================================================================

// -----------------------------------------------------------------------------
// Ambient sketch stubs — shapes only, enough to make the usage read for real.
// -----------------------------------------------------------------------------

type Duration = string; // '5 minutes' etc — cloudflare:workers duration strings

interface StepDesc {
  readonly kind: 'step' | 'units' | 'phase';
}
declare function step(): StepDesc; //  total = 1     → renders plain
declare function units(): StepDesc; // total = n|null → renders 5/10 or 5…
declare function phase(): StepDesc; // total = 1, but wraps MANY engine steps

type StepsShape = Record<string, StepDesc>;

interface FlowDef<Name extends string, P, S extends StepsShape> {
  readonly name: Name;
  readonly key: (params: P) => string; // dedup identity: same key → attach
  readonly steps: S;
}
declare function defineFlow<
  const Name extends string,
  P,
  const S extends StepsShape,
>(def: {
  name: Name;
  key: (params: P) => string;
  steps: S;
}): FlowDef<Name, P, S>;

/** Scoped engine step handed to a phase body. Names are prefixed with the
 *  phase key (`translate/plan`, `translate/batch/wait-3`) — legible traces,
 *  stable mock targets for vitest introspection, valid `restart({from})`
 *  anchors. */
interface PhaseStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: Duration): Promise<void>;
  /** THE missing primitive: sleep/check until `isDone` or budget exhausted.
   *  Internally `sleep(`${name}/wait-${i}`)` + `do(`${name}/check-${i}`)`.
   *  Returns the last value and whether the predicate was ever satisfied —
   *  the caller decides what an unsettled poll means (batch translate
   *  deliberately warns-and-retrieves-anyway). */
  poll<T>(
    name: string,
    opts: { every: Duration; atMost: number },
    check: () => Promise<T>,
    isDone: (value: T) => boolean,
  ): Promise<{ value: T; settled: boolean }>;
  waitForEvent<T>(
    name: string,
    opts: { type: string; timeout?: Duration },
  ): Promise<T>;
}

type JoinOutcome<T> =
  | { status: 'complete'; output: T }
  | { status: 'failed'; error: string };

/** The per-run tracker. S is the definition's step shape; helpers typed
 *  against a SUBSET of S accept any flow that structurally contains it. */
interface Flow<S extends StepsShape> {
  /** One logical step = one engine step. Logs inside the body (replay-safe),
   *  bounded default retry config, error rethrown untouched. */
  step<K extends keyof S, T>(key: K, fn: () => Promise<T>): Promise<T>;

  /** One logical step, many engine steps. Reports running at entry,
   *  complete/failed on resolve/throw. */
  phase<K extends keyof S, T>(
    key: K,
    fn: (s: PhaseStep) => Promise<T>,
  ): Promise<T>;

  /** Known-set fan-out. `list` runs as engine step `${key}/list` (memoized →
   *  replay-safe source of truth for the unit set); each unit as
   *  `${key}/${id(item)}` at bounded concurrency. Auto expect/done. Returns
   *  collected memoized results. A unit throw fails the step (Promise.all
   *  semantics; in-flight losers finish and memoize, per the design doc). */
  map<K extends keyof S, I, T>(
    key: K,
    list: () => Promise<I[]>,
    unit: (item: I) => Promise<T>,
    opts: { concurrency: number; id: (item: I) => string },
  ): Promise<T[]>;

  /** Unknown-length stream: page numbers until DRAIN_STOP (design doc §drain —
   *  pool owns the counter and the stop flag; sentinel page reports no unit).
   *  Returns collected results of the non-sentinel pages. */
  drain<K extends keyof S, T>(
    key: K,
    worker: (page: number) => Promise<T | typeof DRAIN_STOP>,
    opts: { concurrency: number },
  ): Promise<T[]>;

  /** Stored, intentional skip. The hub's completeness check (every declared
   *  step terminal-or-skipped when a run completes) makes a forgotten step a
   *  loud log line instead of a forever-pending segment. */
  skip<K extends keyof S>(key: K, reason?: string): void;

  /** Start-or-attach a child flow (hub-deduped by the child def's key) and
   *  await its terminal state as a step. Under the hood: hub.start() returns
   *  the child runId; parent does step.waitForEvent({ type: `flow:${runId}` });
   *  the hub, which receives every run's terminal status report anyway,
   *  sendEvent()s all registered waiters. Parent hibernates ('waiting' — no
   *  concurrency slot). waitForEvent timeout → one status poll → re-wait. */
  join<K extends keyof S, CP, CT>(
    key: K,
    def: FlowDef<string, CP, StepsShape>,
    params: CP,
  ): Promise<CT>;
  joinSettled<K extends keyof S, CP, CT>(
    key: K,
    def: FlowDef<string, CP, StepsShape>,
    params: CP,
  ): Promise<JoinOutcome<CT>>;

  /** Low-level handle — the escape hatch for shapes map/drain can't express
   *  (keyset loops where page N+1 needs page N's cursor). */
  open<K extends keyof S>(
    key: K,
  ): {
    expect(total: number | null): Promise<void>;
    unit<T>(id: string, fn: () => Promise<T>): Promise<T>;
    done(): Promise<void>;
  };
}

declare const DRAIN_STOP: unique symbol;

// Domain stubs (real ones live in @hiroba/*).
type ItemType = 'news' | 'topic';
type Lang = { code: string; label: string };
declare const deps: {
  db: unknown;
  apiKey: string;
  log: { info(m: string): void; warn(m: string): void };
};
declare function getEnabledLanguages(db: unknown): Promise<Lang[]>;
declare function fetchAndSaveArticleBody(
  db: unknown,
  t: string,
  id: string,
): Promise<{ success: boolean }>;
declare function extractAndSaveEvents(
  db: unknown,
  key: string,
  t: string,
  id: string,
): Promise<{ eventIds: string[] }>;
declare function tagArticleEvents(
  db: unknown,
  key: string,
  t: string,
  id: string,
  ids: string[],
): Promise<unknown>;
declare function getImageCandidates(
  db: unknown,
  t: string,
  id: string,
): Promise<{ key: string }[]>;
declare function planTranslate(
  d: typeof deps,
  t: string,
  id: string,
): Promise<{ mode: 'sync' | 'batch' }>;
declare function translateArticle(
  d: typeof deps,
  t: string,
  id: string,
  ev: string[],
  l: Lang[],
): Promise<TranslateResult>;
declare function submitBodyBatch(
  d: typeof deps,
  t: string,
  id: string,
  l: Lang[],
): Promise<{ batchName: string }>;
declare function pollBodyBatch(key: string, batch: string): Promise<string>;
declare function isBatchTerminal(state: string): boolean;
declare function retrieveBodyBatch(
  d: typeof deps,
  t: string,
  id: string,
  batch: string,
  l: Lang[],
): Promise<TranslateResult>;
declare function mirrorAndTranscribeImage(
  db: unknown,
  key: string,
): Promise<{ hadText: boolean }>;
declare function localizeOneImage(
  db: unknown,
  key: string,
  lang: string,
): Promise<{ localized: boolean }>;
declare function findArticlesPage(
  db: unknown,
  term: string,
  t: string,
  after: string | null,
  n: number,
): Promise<string[]>;
type TranslateResult = { success: boolean; fieldsTranslated: number };

// -----------------------------------------------------------------------------
// 1. Definitions — fragments compose; insertion order is segment order
// -----------------------------------------------------------------------------

const intake = { loadLanguages: step(), fetchBody: step() };
const imagework = { images: units() }; // one unit per referenced image (join per unit)
const output = { translate: phase(), localizeImages: units() };

export const ArticleFlow = defineFlow({
  name: 'article',
  key: (p: { itemType: ItemType; itemId: string }) =>
    `${p.itemType}:${p.itemId}`,
  steps: {
    ...intake,
    extractEvents: step(),
    tagEvents: step(),
    ...imagework,
    ...output,
  },
});

export const PlayguideFlow = defineFlow({
  name: 'playguide',
  key: (p: { slug: string }) => p.slug,
  // No event steps declared at all — no eternal skips, no branch in the body.
  steps: { ...intake, ...imagework, ...output },
});

/** Shared image ingest (mirror → transcribe), keyed BY IMAGE. Two articles
 *  referencing the same image attach to the same child run — the hub's dedup
 *  replaces the D1 image-row state machine as the cross-article coordination
 *  point. */
export const ImageIngestFlow = defineFlow({
  name: 'image-ingest',
  key: (p: { imageKey: string }) => p.imageKey,
  steps: { mirror: step(), transcribe: step() },
});

/** Localized raster generation, keyed by (image, language). Depends on the
 *  translated spans an ARTICLE's translate step produced — so it's started by
 *  articles after translate, and attached-to by every other article sharing
 *  the image. */
export const ImageLocalizeFlow = defineFlow({
  name: 'image-localize',
  key: (p: { imageKey: string; lang: string }) => `${p.imageKey}:${p.lang}`,
  steps: { generate: step() },
});

export const GlossaryRegenFlow = defineFlow({
  name: 'glossary-regen',
  key: (p: { sourceText: string }) => p.sourceText,
  steps: {
    scanArticles: units(),
    retriggerArticles: units(),
    retranslateImages: units(),
  },
});

// -----------------------------------------------------------------------------
// 2. The translate phase — poll() deletes the dance; the body reads at one
//    altitude. Lives NEXT TO the batch code it orchestrates, not in the flow.
// -----------------------------------------------------------------------------

export async function translateSizeGated(
  s: PhaseStep,
  d: typeof deps,
  itemType: string,
  itemId: string,
  eventIds: string[],
  languages: Lang[],
): Promise<TranslateResult> {
  const plan = await s.do('plan', () => planTranslate(d, itemType, itemId));
  if (plan.mode === 'sync') {
    return s.do('sync', () =>
      translateArticle(d, itemType, itemId, eventIds, languages),
    );
  }

  const handle = await s.do('submit', () =>
    submitBodyBatch(d, itemType, itemId, languages),
  );
  const { settled } = await s.poll(
    'batch',
    { every: '5 minutes', atMost: 288 }, // ≈ 24h, mirrors BATCH_MAX_POLLS
    () => pollBodyBatch(d.apiKey, handle.batchName),
    isBatchTerminal,
  );
  if (!settled)
    d.log.warn(`batch ${handle.batchName} unsettled — retrieving anyway`);
  return s.do('retrieve', () =>
    retrieveBodyBatch(d, itemType, itemId, handle.batchName, languages),
  );
}

// -----------------------------------------------------------------------------
// 3. Shared body fragment — typed against the SUBSET it needs. Any flow whose
//    shape includes these keys can pass its tracker (structural typing).
// -----------------------------------------------------------------------------

async function imageAndOutputPipeline(
  f: Flow<typeof imagework & typeof output>,
  d: typeof deps,
  itemType: string,
  itemId: string,
  eventIds: string[],
  languages: Lang[],
): Promise<void> {
  // One unit per image; each unit is a JOIN on the shared per-image child.
  // joinSettled, not join: a failed image DEGRADES the article, never blocks
  // it — the policy that today lives in D1 row states moves here, into code.
  await f.map(
    'images',
    () => getImageCandidates(d.db, itemType, itemId), // engine step images/list
    (img) => f.joinSettled('images', ImageIngestFlow, { imageKey: img.key }),
    { concurrency: 8, id: (img) => img.key },
  );

  const translate = await f.phase('translate', (s) =>
    translateSizeGated(s, d, itemType, itemId, eventIds, languages),
  );

  await f.map(
    'localizeImages',
    () => getImageCandidates(d.db, itemType, itemId),
    (img) =>
      Promise.all(
        languages.map((l) =>
          f.joinSettled('localizeImages', ImageLocalizeFlow, {
            imageKey: img.key,
            lang: l.code,
          }),
        ),
      ),
    { concurrency: 4, id: (img) => img.key },
  );

  void translate;
}

// -----------------------------------------------------------------------------
// 4. The flow bodies themselves — thin, one altitude, no scaffolding
// -----------------------------------------------------------------------------

export async function articleFlowBody(
  f: Flow<(typeof ArticleFlow)['steps']>,
  params: { itemType: ItemType; itemId: string },
  d: typeof deps,
) {
  const { itemType, itemId } = params;
  const languages = await f.step('loadLanguages', () =>
    getEnabledLanguages(d.db),
  );
  await f.step('fetchBody', () =>
    fetchAndSaveArticleBody(d.db, itemType, itemId),
  );

  const events = await f.step('extractEvents', () =>
    extractAndSaveEvents(d.db, d.apiKey, itemType, itemId),
  );
  await f.step('tagEvents', () =>
    tagArticleEvents(d.db, d.apiKey, itemType, itemId, events.eventIds),
  );

  await imageAndOutputPipeline(
    f,
    d,
    itemType,
    itemId,
    events.eventIds,
    languages,
  );
}

export async function playguideFlowBody(
  f: Flow<(typeof PlayguideFlow)['steps']>,
  params: { slug: string },
  d: typeof deps,
) {
  const languages = await f.step('loadLanguages', () =>
    getEnabledLanguages(d.db),
  );
  await f.step('fetchBody', () =>
    fetchAndSaveArticleBody(d.db, 'playguide', params.slug),
  );
  // No events steps to skip — they were never declared.
  await imageAndOutputPipeline(f, d, 'playguide', params.slug, [], languages);
}

/** Glossary regen becomes a map of joins: today it fire-and-forgets DO
 *  triggers and cannot even say when the regeneration finished; joined, the
 *  units ARE the child article runs, so the tracker segment reads 37/112 and
 *  completion means completion. Bounded concurrency bounds in-flight children
 *  (the real constraint is LLM rate limits, same as today's paged triggers). */
export async function glossaryRegenBody(
  f: Flow<(typeof GlossaryRegenFlow)['steps']>,
  params: { sourceText: string },
  d: typeof deps,
) {
  // Keyset pagination = the escape-hatch handle: page N+1 needs page N's
  // cursor, so the pool can't own the counter (design doc §drain, inverted).
  const scan = f.open('scanArticles');
  await scan.expect(null);
  const affected: { itemType: ItemType; itemId: string }[] = [];
  for (const itemType of ['news', 'topic'] as const) {
    let after: string | null = null;
    for (let page = 0; ; page++) {
      const ids: string[] = await scan.unit(`${itemType}:${page}`, () =>
        findArticlesPage(d.db, params.sourceText, itemType, after, 100),
      );
      if (ids.length === 0) break;
      affected.push(...ids.map((itemId) => ({ itemType, itemId })));
      after = ids[ids.length - 1];
      if (ids.length < 100) break;
    }
  }
  await scan.done();

  await f.map(
    'retriggerArticles',
    async () => affected, // already durable: rebuilt from memoized scan units on replay
    (a) => f.join('retriggerArticles', ArticleFlow, a),
    { concurrency: 10, id: (a) => `${a.itemType}:${a.itemId}` },
  );
}

// -----------------------------------------------------------------------------
// 5. Hub — ONE Durable Object, ONE SQLite database, all control-plane state
// -----------------------------------------------------------------------------
//
//   runs     (run_id PK, flow, key, params, status, error, seq, created_at, updated_at)
//   steps    (run_id, step, state, attempt, total, ord, PRIMARY KEY (run_id, step))
//   units    (run_id, step, unit, PRIMARY KEY (run_id, step, unit))
//   waiters  (child_run_id, parent_instance_id, PRIMARY KEY (child_run_id, parent_instance_id))
//   throttle (flow, key, last_attempt, PRIMARY KEY (flow, key))
//
//   CREATE UNIQUE INDEX runs_active_key ON runs(flow, key)
//     WHERE status IN ('queued','running','paused');   -- ≤1 active run per key
//
// start(def, params) — LOCK-FREE. The trick is generating the instance id
// OURSELVES so the durable claim (INSERT) happens BEFORE the engine create:
//
//   1. row = SELECT active run WHERE flow=?, key=?          -- sync, atomic
//      if row: return { runId: row.run_id, existing: true } -- attach
//      (staleness handled lazily: if the engine later reports the row dead,
//       CAS it — UPDATE ... WHERE run_id=? AND status=?     -- and retry start)
//   2. runId = crypto.randomUUID()
//      INSERT runs(run_id, flow, key, status='queued', …)   -- sync, atomic;
//      -- the partial unique index IS the lock: a concurrent racer's INSERT
//      -- throws here, and the loser SELECTs the winner's row and attaches.
//   3. await env[binding(def)].create({ id: runId, params }) -- the ONLY await
//      on failure: DELETE the row (compensate) and rethrow.
//
// Every SQLite statement is synchronous, and the DO is single-threaded between
// awaits — so steps 1–2 are atomic without blockConcurrencyWhile. The index
// carries correctness; an optional per-key in-memory promise mutex only saves
// duplicate engine probes under racing starts (optimization, not safety).
//
// report(report) — unchanged from progress-v3 (idempotent by PK, seq bump,
// SSE fanout) — PLUS: when a terminal status lands, SELECT waiters for that
// run and instance.sendEvent({ type: `flow:${runId}` }) each one (best-effort;
// a parent that misses the event falls back to its waitForEvent-timeout poll).
//
// join registration — the parent's join() calls hub.start() (getting runId,
// possibly attaching to an existing child), INSERTs its own instance id into
// waiters, then waitForEvent({ type: `flow:${runId}` }). Event type is the
// child RUN ID, not the child key — run ids are bounded (event types cap at
// 100 chars; image keys don't).
// -----------------------------------------------------------------------------
