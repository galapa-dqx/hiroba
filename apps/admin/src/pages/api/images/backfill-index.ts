/**
 * Backfill the article_images reverse index from existing block trees:
 *
 *   POST /api/images/backfill-index    { itemType: 'news'|'topic'|'playguide', cursor?: string }
 *
 * New blocks_ja writes maintain the index automatically (syncArticleImages);
 * this walks articles that predate it. Batched: a non-null `nextCursor` means
 * more pages remain — loop per item type until `done` is true. Idempotent, so
 * it doubles as a re-sync tool if the index is ever suspected stale.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { backfillArticleImages, createDb, type ArticleType } from '@hiroba/db';

const ITEM_TYPES: ReadonlySet<string> = new Set(['news', 'topic', 'playguide']);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);

  const body = (await request.json().catch(() => ({}))) as {
    itemType?: unknown;
    cursor?: unknown;
  };
  const itemType = typeof body.itemType === 'string' ? body.itemType : '';
  if (!ITEM_TYPES.has(itemType)) {
    return json(
      { error: "itemType must be 'news', 'topic', or 'playguide'" },
      400,
    );
  }
  const cursor = typeof body.cursor === 'string' ? body.cursor : null;

  const result = await backfillArticleImages(
    db,
    itemType as ArticleType,
    cursor,
  );
  return json({
    processed: result.processed,
    done: result.nextCursor === null,
    nextCursor: result.nextCursor,
  });
};
