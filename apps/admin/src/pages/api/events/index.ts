/**
 * GET /api/events - List events with optional filtering
 * DELETE /api/events/:id - Delete an event
 */

import type { APIRoute } from 'astro';
import { and, desc, eq, like } from 'drizzle-orm';

import { createDb, events, translations } from '@hiroba/db';

export const GET: APIRoute = async ({ locals, url }) => {
  const runtime = locals.runtime;
  const db = createDb(runtime.env.DB);

  const limit = parseInt(url.searchParams.get('limit') || '100');
  const type = url.searchParams.get('type') || undefined;
  const search = url.searchParams.get('search') || undefined;

  let query = db
    .select()
    .from(events)
    .orderBy(desc(events.startTime))
    .limit(limit);

  if (type) {
    query = query.where(eq(events.type, type)) as typeof query;
  }

  if (search) {
    query = query.where(like(events.titleJa, `%${search}%`)) as typeof query;
  }

  const items = await query.all();

  // Get translations for these events
  const eventIds = items.map((e) => e.id);
  const eventTranslations =
    eventIds.length > 0
      ? await db
          .select()
          .from(translations)
          .where(
            and(
              eq(translations.itemType, 'event'),
              eq(translations.language, 'en'),
              eq(translations.field, 'title'),
            ),
          )
          .all()
      : [];

  const translationMap = new Map(
    eventTranslations
      .filter((t) => eventIds.includes(t.itemId))
      .map((t) => [t.itemId, t.value]),
  );

  // Expose times as UTC instant ISO strings. The event `type` tells the client
  // whether to render at date or time granularity; JST is reconstructed in-browser.
  const itemsWithTranslations = items.map((item) => ({
    ...item,
    startTime: item.startTime.toInstant().toString(),
    endTime: item.endTime?.toInstant().toString() ?? null,
    createdAt: item.createdAt.toString(),
    titleEn: translationMap.get(item.id) || null,
  }));

  return new Response(JSON.stringify({ items: itemsWithTranslations }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
