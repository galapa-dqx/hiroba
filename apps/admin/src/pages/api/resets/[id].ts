/**
 * DELETE /api/resets/:id — remove a reset definition, then re-materialize so its
 * calendar marks disappear immediately (rather than on the next nightly cron).
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { Temporal } from 'temporal-polyfill';

import {
  createDb,
  deleteResetMilestone,
  materializeResetEvents,
} from '@hiroba/db';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const DELETE: APIRoute = async ({ params }) => {
  const db = createDb(env.DB);
  const id = params.id!;

  await deleteResetMilestone(db, id);
  await materializeResetEvents(db, { now: Temporal.Now.instant() });

  return json({ success: true, id });
};
