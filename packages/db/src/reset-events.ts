/**
 * Materialize recurring reset definitions (`reset_milestones`) into `events`
 * rows for a forward window.
 *
 * The builder half (`buildResetEvents`) is pure (defs + window in, rows out) so
 * it unit-tests without a DB — the same shape as `build-schedule-events.ts` in
 * the workflow. The DB half (`materializeResetEvents` and friends, moved here
 * from queries.ts in DQX-51) swaps the built window into `events` and prunes
 * the passed marks.
 *
 * Each occurrence becomes a point-in-time `mark`. Occurrences that fall on the
 * exact same instant (the common case — every reset fires at 06:00 JST, so on a
 * Sunday the daily + weekly resets coincide) are merged into a single mark whose
 * title joins the active reset names, in `sortOrder`. Per-language merged titles
 * are returned alongside for the `translations` table; the calendar then reads
 * them back through the ordinary event-title path.
 */

import { and, eq, gte, inArray, lt } from 'drizzle-orm';
import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from 'temporal-polyfill';

import type { Database } from './client';
import { chunked } from './d1-limits';
import { events, type NewEvent } from './schema/events';
import { getEnabledLanguages } from './schema/languages';
import type { ResetMilestone } from './schema/reset-milestones';
import { translations } from './schema/translations';

/** JA merged-title separator vs. Latin-script languages. */
const SEP_JA = '・';
const SEP = ' · ';

/** A merged mark's per-language display names, keyed by language code. */
export type ResetTitleMap = Map<string, Record<string, string>>;

export type BuildResetEventsResult = {
  events: NewEvent[];
  /** eventId → { [language]: mergedTitle } for the enabled languages. */
  titles: ResetTitleMap;
};

/** One reset's name in a language, falling back language → en → Japanese. */
function nameFor(def: ResetMilestone, language: string): string {
  return def.titles[language] ?? def.titles.en ?? def.titleJa;
}

/**
 * Build the reset `events` rows (and their per-language titles) for every
 * occurrence in `[from, to]`. `languages` is the set of enabled translation
 * targets (Japanese is the source and lives on `titleJa`, not here).
 */
export function buildResetEvents(
  defs: ResetMilestone[],
  from: Temporal.ZonedDateTime,
  to: Temporal.ZonedDateTime,
  languages: string[],
  now: Temporal.Instant,
): BuildResetEventsResult {
  // Group the coincident defs firing at each instant: epochMs → members.
  const groups = new Map<
    number,
    { start: Temporal.ZonedDateTime; defs: ResetMilestone[] }
  >();

  for (const def of defs) {
    if (!def.enabled) continue;
    // rrule-temporal returns its own temporal-spec ZonedDateTime; we only read
    // `.toString()` off it and re-parse through our polyfill below, so leave the
    // element type inferred rather than pinning it to our Temporal.
    let occurrences;
    try {
      occurrences = new RRuleTemporal({ rruleString: def.rrule }).between(
        from,
        to,
        true,
      );
    } catch {
      // A malformed rule (shouldn't persist — the admin API validates on save)
      // contributes no occurrences rather than sinking the whole materialize.
      continue;
    }
    for (const occ of occurrences) {
      // Re-parse through our own polyfill so every downstream ZonedDateTime is
      // a native instance of the Temporal our column mapper expects.
      const start = Temporal.ZonedDateTime.from(occ.toString(), {
        offset: 'ignore',
      });
      const key = start.toInstant().epochMilliseconds;
      const group = groups.get(key);
      if (group) group.defs.push(def);
      else groups.set(key, { start, defs: [def] });
    }
  }

  const events: NewEvent[] = [];
  const titles: ResetTitleMap = new Map();

  for (const { start, defs: members } of groups.values()) {
    members.sort(
      (a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id),
    );
    const id = resetEventId(start, members);
    const titleJa = members.map((d) => d.titleJa).join(SEP_JA);

    events.push({
      id,
      type: 'mark',
      titleJa,
      startTime: start,
      endTime: null,
      sourceType: RESET_SOURCE_TYPE,
      sourceId: null,
      createdAt: now,
    });

    const perLang: Record<string, string> = {};
    for (const language of languages) {
      perLang[language] = members.map((d) => nameFor(d, language)).join(SEP);
    }
    titles.set(id, perLang);
  }

  return { events, titles };
}

/** `events.source_type` marking a materialized reset milestone. */
export const RESET_SOURCE_TYPE = 'reset';

/** Deterministic id from the merged mark's identity (instant | member ids). */
function resetEventId(
  start: Temporal.ZonedDateTime,
  members: ResetMilestone[],
): string {
  const str = [
    start.toString({ offset: 'never' }),
    members.map((d) => d.id).join(','),
  ].join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i);
    hash = hash & hash; // 32-bit
  }
  return `reset-${Math.abs(hash).toString(16).padStart(8, '0')}`;
}

/**
 * Swap in a freshly materialized set of reset `mark` events (sourceType='reset')
 * for the forward window starting at `from`: delete the existing reset rows from
 * `from` onward (clearing anything a disabled/edited def no longer covers) with
 * their title translations, then insert the new rows and per-language titles.
 * Batched to stay under D1's ~100 bound-parameter cap; deterministic ids let a
 * partial failure self-heal on the next run.
 */
async function replaceResetEvents(
  db: Database,
  rows: NewEvent[],
  titles: ResetTitleMap,
  from: Temporal.ZonedDateTime,
  now: Temporal.Instant,
): Promise<void> {
  // Clear the window we're about to rewrite (drizzle serializes the bound
  // ZonedDateTime with the column's own offset:'never' mapping).
  const stale = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.sourceType, RESET_SOURCE_TYPE),
        gte(events.startTime, from),
      ),
    )
    .all();
  const staleIds = stale.map((r) => r.id);
  await chunked(staleIds, async (slice) => {
    await db.delete(events).where(inArray(events.id, slice));
    await db
      .delete(translations)
      .where(
        and(
          eq(translations.itemType, 'event'),
          inArray(translations.itemId, slice),
        ),
      );
    return [];
  });

  // 8 bound params per event; D1 caps a statement at 100, so 12 rows max.
  const EVENTS_PER_INSERT = 12;
  for (let i = 0; i < rows.length; i += EVENTS_PER_INSERT) {
    const batch = rows.slice(i, i + EVENTS_PER_INSERT);
    if (batch.length > 0) {
      await db.insert(events).values(batch).onConflictDoNothing();
    }
  }

  // Flatten the per-language titles into translation rows (state='done', so the
  // CHECK requires value + translatedAt + model — these are admin-authored, not
  // AI output, so the model marker is the source tag).
  const titleRows: (typeof translations.$inferInsert)[] = [];
  for (const row of rows) {
    const perLang = titles.get(row.id);
    if (!perLang) continue;
    for (const [language, value] of Object.entries(perLang)) {
      titleRows.push({
        itemType: 'event',
        itemId: row.id,
        language,
        field: 'title',
        state: 'done',
        value,
        translatedAt: now,
        model: RESET_SOURCE_TYPE,
        updatedAt: now,
      });
    }
  }
  // 9 bound params per translation row → 10 rows max under the cap.
  const TITLES_PER_INSERT = 10;
  for (let i = 0; i < titleRows.length; i += TITLES_PER_INSERT) {
    const batch = titleRows.slice(i, i + TITLES_PER_INSERT);
    if (batch.length > 0) {
      await db.insert(translations).values(batch).onConflictDoNothing();
    }
  }
}

/**
 * Prune materialized reset events (sourceType='reset') that have already passed,
 * with their title translations. Reset rows accrete forever (one mark per day),
 * so a retention horizon keeps the table bounded. Returns the number deleted.
 */
export async function pruneResetEvents(
  db: Database,
  cutoff: Temporal.ZonedDateTime,
): Promise<number> {
  const stale = await db
    .select({ id: events.id })
    .from(events)
    .where(
      and(
        eq(events.sourceType, RESET_SOURCE_TYPE),
        lt(events.startTime, cutoff),
      ),
    )
    .all();
  if (stale.length === 0) return 0;

  const ids = stale.map((r) => r.id);
  await chunked(ids, async (slice) => {
    await db.delete(events).where(inArray(events.id, slice));
    await db
      .delete(translations)
      .where(
        and(
          eq(translations.itemType, 'event'),
          inArray(translations.itemId, slice),
        ),
      );
    return [];
  });
  return ids.length;
}

/** Default forward window materialized by {@link materializeResetEvents}. */
const RESET_HORIZON_DAYS = 120;

/**
 * Materialize the enabled reset definitions into `events` for a forward window
 * and swap them in. The window starts at midnight JST *today* (so a reset that
 * already fired earlier today still shows on today's calendar) and runs
 * `horizonDays` ahead. Shared by the nightly cron and the admin editor (which
 * re-materializes on save so edits appear without waiting for the cron).
 * Returns how many merged marks were written.
 */
export async function materializeResetEvents(
  db: Database,
  opts: { now?: Temporal.Instant; horizonDays?: number } = {},
): Promise<{ marks: number }> {
  const now = opts.now ?? Temporal.Now.instant();
  const horizonDays = opts.horizonDays ?? RESET_HORIZON_DAYS;

  const from = now
    .toZonedDateTimeISO('Asia/Tokyo')
    .toPlainDate()
    .toZonedDateTime('Asia/Tokyo');
  const to = from.add({ days: horizonDays });

  const [defs, languages] = await Promise.all([
    db.query.resetMilestones.findMany({
      orderBy: { sortOrder: 'asc', id: 'asc' },
    }),
    getEnabledLanguages(db),
  ]);
  const { events: rows, titles } = buildResetEvents(
    defs,
    from,
    to,
    languages.map((l) => l.code),
    now,
  );
  await replaceResetEvents(db, rows, titles, from, now);
  return { marks: rows.length };
}
