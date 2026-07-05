/**
 * Translation attribute reconciliation.
 *
 * RTML is built so that every human-readable string is *element content* and
 * every non-linguistic value (src, href, color value, variant, …) is an
 * *attribute* (see rtml.ts). The translation LLM is therefore only ever supposed
 * to rewrite the text between tags; it must copy attributes through verbatim.
 *
 * In practice it occasionally doesn't — most damagingly it mangles image/link
 * URLs (e.g. dropping the `hiroba` label from `cache.hiroba.dqx.jp`, yielding a
 * dead host that 404s or fails DNS at serve time). Because those attributes are
 * non-linguistic, the *source* (JA) tree is ground truth: we can walk both trees,
 * restore any attribute the translation changed, and log every repair.
 *
 * Pairing strategy: collect the typed nodes of each tree in document order,
 * bucket by node type, and pair by index — the same index alignment the
 * image-text extraction already relies on. It is gated per type on an equal
 * count: if the translation added or dropped a node of some type we can't pair
 * that bucket safely, so we record a {@link Divergence} and leave it untouched
 * rather than guess. This tolerates the LLM reflowing text (which changes bare
 * strings, never the typed-node sequence) while catching structural drift.
 *
 * Only non-linguistic attributes are reconciled (see {@link RECONCILE_ATTRS}).
 * Linguistic fields — `alt`, image `text` spans, `speaker`/`name`/`role`,
 * section/interview titles, badge text, ranking counts, and all child content —
 * are the translation's job and are never touched.
 */

import type { Block, Inline } from './schema';
import { walk } from './traverse';

/** A node carrying a `type` discriminant (every node except bare-string text). */
type TypedNode = Exclude<Inline, string> | Block;

/**
 * Per-type allowlist of non-linguistic attributes to restore from the source.
 * Everything not listed here — all child arrays and every linguistic string
 * (`alt`, `text`, `speaker`, `name`, `role`, titles, badge `text`, `count`) — is
 * left as the translation produced it. Structural discriminants (`type`,
 * heading `level`) are never rewritten either: a change there is real divergence,
 * not attribute drift.
 */
const RECONCILE_ATTRS: Record<string, readonly string[]> = {
  // URL-bearing (the high-impact cases: a bad URL is a hard failure at serve).
  image: ['src', 'href', 'external', 'variant', 'sources'],
  icon: ['src'],
  video: ['src', 'provider'],
  embed: ['provider', 'variant', 'content'],
  link: ['href', 'external'],
  button: ['href', 'variant'],
  speechBubble: ['icon'],
  // Style / structure (cosmetic drift, but still invariant under translation).
  color: ['value'],
  badge: ['variant'],
  paragraph: ['align'],
  heading: ['variant', 'anchor'],
  infoBox: ['variant'],
  section: ['variant'],
  list: ['ordered', 'variant'],
  table: ['variant'],
  steps: ['variant'],
  ranking: ['variant'],
  // Workflow-inserted annotations (tag-events): machine values, never prose.
  time: ['datetime'],
  event: ['id', 'start', 'end'],
};

/** One restored attribute: `nodeType`'s `index`-th node had `field` reset. */
export type Repair = {
  nodeType: string;
  /** Index of the node within its type bucket (document order). */
  index: number;
  field: string;
  /** The value the translation produced (removed). */
  from: unknown;
  /** The source value restored (or `undefined` when the field was dropped). */
  to: unknown;
};

/** A type bucket whose source/translation counts differ — skipped, not paired. */
export type Divergence = {
  nodeType: string;
  sourceCount: number;
  translatedCount: number;
};

export type ReconcileReport = {
  repairs: Repair[];
  divergences: Divergence[];
};

/** Every typed node in a block tree, in document order (pre-order walk). */
function collectTypedNodes(blocks: Block[]): TypedNode[] {
  const out: TypedNode[] = [];
  walk(blocks, (n) => {
    if (typeof n !== 'string') out.push(n);
  });
  return out;
}

/** Bucket nodes by their `type` discriminant, preserving document order. */
function bucketByType(nodes: TypedNode[]): Map<string, TypedNode[]> {
  const byType = new Map<string, TypedNode[]>();
  for (const node of nodes) {
    const bucket = byType.get(node.type);
    if (bucket) bucket.push(node);
    else byType.set(node.type, [node]);
  }
  return byType;
}

/** Structural equality for attribute values (only `sources` is non-scalar). */
const valuesEqual = (a: unknown, b: unknown): boolean =>
  a === b ||
  (typeof a === 'object' &&
    a !== null &&
    typeof b === 'object' &&
    b !== null &&
    JSON.stringify(a) === JSON.stringify(b));

/** Deep-clone an attribute value so restored arrays don't alias the source. */
const cloneValue = <T>(v: T): T =>
  typeof v === 'object' && v !== null
    ? (JSON.parse(JSON.stringify(v)) as T)
    : v;

/**
 * Restore non-linguistic attributes on a translated block tree from its source,
 * mutating `translated` in place and returning a report of what changed.
 *
 * @param source - the JA block tree (ground truth for attributes)
 * @param translated - the parsed EN block tree (mutated in place)
 */
export function reconcileAttributes(
  source: Block[],
  translated: Block[],
): ReconcileReport {
  const src = bucketByType(collectTypedNodes(source));
  const trans = bucketByType(collectTypedNodes(translated));

  const repairs: Repair[] = [];
  const divergences: Divergence[] = [];

  for (const [type, attrs] of Object.entries(RECONCILE_ATTRS)) {
    const srcNodes = src.get(type) ?? [];
    const transNodes = trans.get(type) ?? [];

    if (srcNodes.length !== transNodes.length) {
      // Can't pair by index — record it and leave this bucket untouched.
      if (srcNodes.length > 0 || transNodes.length > 0)
        divergences.push({
          nodeType: type,
          sourceCount: srcNodes.length,
          translatedCount: transNodes.length,
        });
      continue;
    }

    for (let i = 0; i < srcNodes.length; i++) {
      const srcNode = srcNodes[i] as Record<string, unknown>;
      const transNode = transNodes[i] as Record<string, unknown>;
      for (const field of attrs) {
        const srcVal = srcNode[field];
        const transVal = transNode[field];
        if (valuesEqual(srcVal, transVal)) continue;
        repairs.push({
          nodeType: type,
          index: i,
          field,
          from: transVal,
          to: srcVal,
        });
        if (srcVal === undefined) delete transNode[field];
        else transNode[field] = cloneValue(srcVal);
      }
    }
  }

  return { repairs, divergences };
}
