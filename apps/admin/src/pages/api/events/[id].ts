/**
 * DELETE /api/events/:id - Delete an event and its translations
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { and, eq } from 'drizzle-orm';

import { createDb, events, translations } from '@hiroba/db';

export const DELETE: APIRoute = async ({ params }) => {
  const db = createDb(env.DB);
  const id = params.id!;

  // Delete translations first
  await db
    .delete(translations)
    .where(
      and(eq(translations.itemType, 'event'), eq(translations.itemId, id)),
    );

  // Delete the event
  await db.delete(events).where(eq(events.id, id));

  return new Response(JSON.stringify({ success: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
