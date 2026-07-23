/**
 * DELETE /api/resets/:id — remove a reset definition, then re-materialize so its
 * calendar marks disappear immediately (rather than on the next nightly cron).
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import { createDb, materializeResetEvents, resetMilestones } from '@hiroba/db';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const DELETE: APIRoute = async ({ params }) => {
  const db = createDb(env.DB);
  const id = params.id!;

  // The definition's materialized events clear on the re-materialize below.
  await db.delete(resetMilestones).where(eq(resetMilestones.id, id));
  await materializeResetEvents(db, { now: Temporal.Now.instant() });

  return json({ success: true, id });
};
