/**
 * Time/event annotation utilities.
 *
 * The workflow's tag-events pass asks an LLM to insert inline `<time>` and
 * `<event>` tags into an article's RTML without changing anything else. These
 * helpers enforce that contract:
 *
 *   • stripTimeEventTags — remove every time/event node, splicing its children
 *     into the parent. Used to (a) undo annotation before re-running extraction
 *     (idempotency) and (b) reduce a tagged tree for comparison.
 *   • tagsPreserveContent — verify a tagged tree is the original tree plus tags
 *     and nothing else.
 *
 * Equality is checked by comparing canonical RTML serializations rather than
 * deep-comparing JSON: tagging legitimately splits text nodes ("期間 7/13 まで"
 * → ["期間 ", …, " まで"]) and parseRtml output orders object keys differently
 * than scraper-built trees. serializeToRtml concatenates adjacent text and is
 * key-order independent, so it rides on the round-trip guarantee.
 */

import { serializeToRtml } from './rtml';
import type { Block, ContentNode } from './schema';
import { mapChildren, walk } from './traverse';

/**
 * Strip time/event nodes from a child list, splicing their children into
 * place; every other node is kept with the strip recursed through its slots.
 * (time/event only occur in inline positions, so the splice keeps each list's
 * tier.)
 */
function stripList(nodes: ContentNode[]): ContentNode[] {
  return nodes.flatMap((n): ContentNode[] => {
    if (typeof n === 'string') return [n];
    if (n.type === 'time' || n.type === 'event') return stripList(n.children);
    return [mapChildren(n, stripList)];
  });
}

/**
 * Remove every `time`/`event` node from the tree, splicing their children into
 * the parent inline run. Pure — returns a new tree; idempotent.
 */
export function stripTimeEventTags(blocks: Block[]): Block[] {
  return blocks.map((b) => mapChildren(b, stripList));
}

/**
 * True when `tagged` is exactly `original` plus (possibly zero) time/event
 * tags — i.e. stripping the tags reproduces the original content, structure,
 * and attributes byte-for-byte in canonical RTML.
 */
export function tagsPreserveContent(
  original: Block[],
  tagged: Block[],
): boolean {
  return (
    serializeToRtml({ title: '', blocks: stripTimeEventTags(tagged) }) ===
    serializeToRtml({ title: '', blocks: stripTimeEventTags(original) })
  );
}

/** Count time and event nodes in a tree (for step result metrics). */
export function countTimeEventTags(blocks: Block[]): {
  timeTags: number;
  eventTags: number;
} {
  let timeTags = 0;
  let eventTags = 0;
  walk(blocks, (n) => {
    if (typeof n === 'string') return;
    if (n.type === 'time') timeTags++;
    else if (n.type === 'event') eventTags++;
  });
  return { timeTags, eventTags };
}
