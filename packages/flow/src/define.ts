/**
 * Definition layer — a flow definition is a standalone importable VALUE.
 *
 * The definition carries three things and nothing else:
 *   - `name`  — tags snapshots and resolves the workflow binding at the hub's
 *               string-dispatch boundary (the ONE place a name→binding map exists);
 *   - `key`   — the dedup identity: two starts whose params map to the same key
 *               attach to one run instead of racing two;
 *   - `steps` — the SHAPE of the run, declared once, ahead of execution. The
 *               segmented progress bar needs the step set before any step runs,
 *               and the admin client needs the keys as a *type* — neither can be
 *               derived from a function body. Bodies live elsewhere (apps/workflow).
 *
 * Steps are an object, not a tuple: ES2015 guarantees insertion order for
 * non-integer string keys, so declaration order IS segment order, and keyed
 * types (`snap.steps.translate`) fall out with no tuple→object remapping.
 * Fragments compose by spreading (`{ ...intake, ...output }`), which is how
 * flows share body helpers structurally (see docs/flow-framework.md).
 */

/** What kind of segment a step renders as. `units` is the only one that seeds
 *  an indeterminate total; `phase` is a single segment that happens to wrap
 *  many engine steps. No behavior hangs off this past seeding + rendering. */
export type StepDesc = {
  readonly kind: 'step' | 'units' | 'phase';
};

/** One logical step = one engine step = one unit. Renders plain. */
export const step = (): StepDesc => ({ kind: 'step' });
/** A set of units, known (`5/10`) or indeterminate (`5…`) at runtime. */
export const units = (): StepDesc => ({ kind: 'units' });
/** One segment wrapping many engine steps (plan/submit/poll/retrieve…). */
export const phase = (): StepDesc => ({ kind: 'phase' });

/**
 * One `units()` segment per member of a literal key list, typed as a mapped
 * type over the list — for flows whose segments mirror a domain enum (one
 * drain per category). Hand-written key objects only guard drift one way
 * (an added member fails the body's `keyof S` check; a removed one leaves a
 * forever-pending declared segment). Deriving the shape from the list makes
 * drift impossible in both directions. Insertion order = list order.
 */
export function unitsForEach<const K extends readonly string[]>(
  keys: K,
): { [P in K[number]]: StepDesc } {
  return Object.fromEntries(keys.map((key) => [key, units()])) as {
    [P in K[number]]: StepDesc;
  };
}

export type StepsShape = Record<string, StepDesc>;

export type FlowDef<
  Name extends string = string,
  P = never,
  S extends StepsShape = StepsShape,
> = {
  readonly name: Name;
  readonly key: (params: P) => string;
  readonly steps: S;
};

/** The loose def type for plumbing that multiplexes every flow (hub, joins).
 *  Tight at the ends, loose in the middle — producers and consumers use the
 *  concrete def value; infrastructure uses this. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyFlowDef = FlowDef<string, any, StepsShape>;

export type StepsOf<D extends AnyFlowDef> = D['steps'];
/** Inferred from the key function so zero-param keys (`key: () => 'banners'`)
 *  resolve to `unknown` instead of an out-of-bounds tuple index. */
export type ParamsOf<D extends AnyFlowDef> = D['key'] extends (
  params: infer P,
) => string
  ? P
  : never;

/**
 * Bundle identity + dedup key + shape into one value. `const` generics capture
 * the literal name and literal step keys (in insertion order).
 *
 * Throws at module load if a step id is a canonical integer-index string
 * ("0", "42"): those reorder ahead of insertion order in JS objects and would
 * silently scramble the segmented bar. Real ids never trip this.
 */
export function defineFlow<
  const Name extends string,
  P,
  const S extends StepsShape,
>(def: {
  name: Name;
  key: (params: P) => string;
  steps: S;
}): FlowDef<Name, P, S> {
  for (const id of Object.keys(def.steps)) {
    if (String(Number(id)) === id) {
      throw new Error(
        `Flow "${def.name}": step id "${id}" is numeric — integer-index keys ` +
          `reorder ahead of insertion order and break segment order. Use a ` +
          `non-numeric id.`,
      );
    }
  }
  return def;
}
