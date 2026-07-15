/**
 * Seed the playguide set by crawling the guide tree from `guide01`, mirroring
 * the daily cron's refreshPlayguides. Upserts discovered pages (metadata only,
 * never clobbering a fetched body) and eagerly translates the newly-discovered
 * titles. The heavy per-page ArticleWorkflow still runs lazily on first view.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';

import { createDb, upsertPlayguideListItems } from '@hiroba/db';
import { crawlPlayguides } from '@hiroba/scraper';

import { enqueueTitleTranslation } from '../../../lib/enqueue-titles';

export const POST: APIRoute = async () => {
  const db = createDb(env.DB);

  const crawled = await crawlPlayguides();
  const inserted = await upsertPlayguideListItems(
    db,
    crawled.map((c) => ({
      id: c.slug,
      titleJa: c.titleJa,
      sortOrder: c.sortOrder,
    })),
  );

  const enqueued = await enqueueTitleTranslation(
    env.FLOW_HUB,
    'playguide',
    inserted.map((i) => i.id),
  );

  return new Response(
    JSON.stringify({
      success: true,
      crawled: crawled.length,
      newItems: inserted.length,
      titlesEnqueued: enqueued ? inserted.length : 0,
    }),
    { headers: { 'Content-Type': 'application/json' } },
  );
};
