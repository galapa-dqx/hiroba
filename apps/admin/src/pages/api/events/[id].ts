/**
 * DELETE /api/events/:id - Delete an event and its translations
 */

import type { APIRoute } from 'astro';
import { and, eq } from 'drizzle-orm';

import { createDb, events, translations } from '@hiroba/db';

export const DELETE: APIRoute = async ({ locals, params }) => {
  const runtime = locals.runtime;
  const db = createDb(runtime.env.DB);
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
