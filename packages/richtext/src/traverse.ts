/**
 * Shared traversal over the Block/Inline tree.
 *
 * Which fields of each node hold child nodes — `children`, list
 * `items[].children`, table `headers`/`rows` cells, interview
 * `exchanges[].question/answer`, image `caption`, section `title`/`dateline`,
 * … — is knowledge that used to be duplicated across every recursive walker.
 * Here it lives in exactly one place: the switch inside {@link mapChildren},
 * which is exhaustive (`satisfies never`), so adding a node type to the schema
 * is a compile error in this file and this file only. {@link childrenOf},
 * {@link walk}, and {@link mapNodes} all derive from it.
 *
 * Deliberately *not* built on this layer:
 *   • rtml.ts serialize/parse — tag vocabulary, serialization order, and
 *     RCDATA handling are bespoke per node type; a generic walk would obscure
 *     them without removing the switch.
 *   • render.ts — every node type renders differently for the same reason.
 * Both are exhaustiveness-checked already (switches whose every case returns).
 *
 * Traversal order is document order, matching RTML serialization: e.g. a
 * section yields title, dateline, then children; a table yields header cells
 * before body rows. Collectors pairing two trees by index (reconcile,
 * image-text hydration) rely on this.
 */

import type { Block, ContentNode, Inline } from './schema';

/**
 * A transform applied to each child list of a node. Lists keep their tier:
 * a slot typed `Inline[]` (paragraph children, section title, …) must get
 * back inline nodes, a slot typed `Block[]` (step bodies, interview answers)
 * blocks — {@link mapChildren} trusts this and casts the result back to the
 * slot's type. Returning a different length is fine (splice/filter).
 */
export type ChildListTransform = (list: ContentNode[]) => ContentNode[];

/**
 * Apply `fn` to every direct child list of `node`, in document order,
 * returning the rebuilt node — THE single source of truth for which fields
 * of each node type hold child nodes. Childless nodes (and childless slots,
 * e.g. an image without a caption) are returned/kept as-is, so absent
 * optional fields stay absent.
 */
export function mapChildren<T extends ContentNode>(
  node: T,
  fn: ChildListTransform,
): T {
  if (typeof node === 'string') return node;
  return mapNodeChildren(node) as T;

  function mapNodeChildren(n: Exclude<ContentNode, string>): ContentNode {
    switch (n.type) {
      // Childless atoms.
      case 'break':
      case 'badge':
      case 'icon':
      case 'divider':
      case 'embed':
        return n;
      // Inline containers and inline-only blocks: `children: Inline[]`.
      case 'strong':
      case 'emphasis':
      case 'color':
      case 'link':
      case 'time':
      case 'event':
      case 'paragraph':
      case 'heading':
      case 'button':
        return { ...n, children: fn(n.children) as Inline[] };
      case 'image':
      case 'video':
        return n.caption ? { ...n, caption: fn(n.caption) as Inline[] } : n;
      case 'infoBox':
      case 'speechBubble':
      case 'messageBox':
        return { ...n, children: fn(n.children) };
      case 'section': {
        const title = n.title && (fn(n.title) as Inline[]);
        const dateline = n.dateline && (fn(n.dateline) as Inline[]);
        const out = { ...n, children: fn(n.children) };
        if (title) out.title = title;
        if (dateline) out.dateline = dateline;
        return out;
      }
      case 'accordion':
        return {
          ...n,
          summary: fn(n.summary) as Inline[],
          children: fn(n.children),
        };
      case 'list':
        return {
          ...n,
          items: n.items.map((it) => ({ ...it, children: fn(it.children) })),
        };
      case 'table': {
        const headers = n.headers?.map((c) => ({
          ...c,
          children: fn(c.children),
        }));
        const rows = n.rows.map((r) =>
          r.map((c) => ({ ...c, children: fn(c.children) })),
        );
        return headers ? { ...n, headers, rows } : { ...n, rows };
      }
      case 'interview':
        return {
          ...n,
          exchanges: n.exchanges.map((e) => ({
            ...e,
            question: fn(e.question) as Inline[],
            answer: fn(e.answer) as Block[],
          })),
        };
      case 'steps':
        return {
          ...n,
          items: n.items.map((s) => ({
            ...s,
            children: fn(s.children) as Block[],
          })),
        };
      case 'ranking':
        return {
          ...n,
          items: n.items.map((i) => ({ ...i, title: fn(i.title) as Inline[] })),
        };
      default:
        return n satisfies never;
    }
  }
}

/**
 * The direct child nodes of a node, flattened across all its slots in
 * document order. Text (a bare string) and atoms have none.
 */
export function childrenOf(node: ContentNode): ContentNode[] {
  if (typeof node === 'string') return [];
  const out: ContentNode[] = [];
  // Collect via the one shape-aware primitive; the rebuilt node is discarded
  // (trees are article-sized, so the throwaway clone is cheaper than a second
  // switch that could drift from mapChildren's).
  mapChildren(node, (list) => {
    out.push(...list);
    return list;
  });
  return out;
}

/**
 * Pre-order visit of every node in the tree (each node before its children,
 * in document order). Visits the live nodes, so callers may collect
 * references to hydrate in place (see collectImages).
 */
export function walk(
  nodes: readonly ContentNode[],
  visit: (node: ContentNode) => void,
): void {
  for (const node of nodes) {
    visit(node);
    walk(childrenOf(node), visit);
  }
}

/**
 * A structure-preserving node transform for {@link mapNodes}. Must keep the
 * node's tier (a Block in, a Block out; an Inline in, an Inline out) so the
 * containment invariant holds; within a tier it may swap types freely.
 */
export type NodeTransform = (node: ContentNode) => ContentNode;

/**
 * Structure-preserving transform: rebuild the tree with `fn` applied to every
 * node, parents before children (the children of the *returned* node are what
 * get traversed). The input tree is not mutated; untouched subtrees may be
 * shared by reference. The intended shape for render-time rewrites, e.g.
 * pointing every image/icon `src` at the R2 proxy.
 */
export function mapNodes(blocks: Block[], fn: NodeTransform): Block[] {
  const mapList = (list: ContentNode[]): ContentNode[] =>
    list.map((node) => {
      const mapped = fn(node);
      return typeof mapped === 'string' ? mapped : mapChildren(mapped, mapList);
    });
  return mapList(blocks) as Block[];
}
