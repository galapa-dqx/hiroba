/**
 * Server-side validation for block trees submitted by the article editor.
 */

import { parseRtml, serializeToRtml, type Block } from '@hiroba/richtext';

/**
 * Validate an incoming block tree by round-tripping it through RTML: the
 * serializer walks every node (throwing on shapes it doesn't know), and the
 * strict parser re-validates the markup. Returns an error message, or null
 * when the tree is valid.
 */
export function validateBlocks(blocks: unknown): string | null {
  if (!Array.isArray(blocks)) return 'blocks must be an array';
  try {
    parseRtml(serializeToRtml({ title: 'x', blocks: blocks as Block[] }));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
