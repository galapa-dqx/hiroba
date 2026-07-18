/**
 * Reset milestones API — GET the definitions (with the enabled languages the
 * editor renders name fields for), POST to create or overwrite one. Deletes live
 * in ./[id].ts. Every write re-materializes the calendar marks so edits show up
 * immediately, without waiting for the nightly cron.
 */

import type { APIRoute } from 'astro';
import { env } from 'cloudflare:workers';
import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from 'temporal-polyfill';

import {
  createDb,
  getEnabledLanguages,
  listResetMilestones,
  materializeResetEvents,
  upsertResetMilestone,
} from '@hiroba/db';

/** Slug we accept as a reset id (also the events-row id seed). */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const GET: APIRoute = async () => {
  const db = createDb(env.DB);

  const [resets, languages] = await Promise.all([
    listResetMilestones(db),
    getEnabledLanguages(db),
  ]);
  return json({
    resets: resets.map((r) => ({
      ...r,
      createdAt: r.createdAt.toString(),
      updatedAt: r.updatedAt.toString(),
    })),
    languages,
  });
};

export const POST: APIRoute = async ({ request }) => {
  const db = createDb(env.DB);

  const body = (await request.json()) as {
    id?: unknown;
    titleJa?: unknown;
    titles?: unknown;
    rrule?: unknown;
    enabled?: unknown;
    sortOrder?: unknown;
    note?: unknown;
  };

  const id = typeof body.id === 'string' ? body.id.trim() : '';
  const titleJa = typeof body.titleJa === 'string' ? body.titleJa.trim() : '';
  const rrule = typeof body.rrule === 'string' ? body.rrule.trim() : '';

  if (!ID_PATTERN.test(id)) {
    return json(
      { error: 'id must be a slug like "daily" or "weekly-sun"' },
      400,
    );
  }
  if (!titleJa) {
    return json({ error: 'titleJa is required' }, 400);
  }
  if (
    typeof body.titles !== 'object' ||
    body.titles === null ||
    Array.isArray(body.titles)
  ) {
    return json({ error: 'titles must be an object of language → name' }, 400);
  }
  // Keep only non-empty string values; the calendar falls back to en → titleJa.
  const titles: Record<string, string> = {};
  for (const [lang, value] of Object.entries(body.titles)) {
    if (typeof value === 'string' && value.trim()) titles[lang] = value.trim();
  }

  // Validate the recurrence up front so a bad rule never persists (and the
  // materializer never has to swallow it).
  try {
    new RRuleTemporal({ rruleString: rrule });
  } catch (err) {
    return json(
      { error: `invalid RRULE: ${err instanceof Error ? err.message : err}` },
      400,
    );
  }

  const now = Temporal.Now.instant();
  await upsertResetMilestone(db, {
    id,
    titleJa,
    titles,
    rrule,
    enabled: body.enabled !== false,
    sortOrder: typeof body.sortOrder === 'number' ? body.sortOrder : 0,
    note:
      typeof body.note === 'string' && body.note.trim()
        ? body.note.trim()
        : null,
    createdAt: now,
    updatedAt: now,
  });

  // Rebuild the materialized marks so the calendar reflects the change now.
  await materializeResetEvents(db, { now });

  return json({ success: true, id });
};
