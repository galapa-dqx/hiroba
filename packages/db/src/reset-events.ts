/**
 * Materialize recurring reset definitions (`reset_milestones`) into `events`
 * rows for a forward window. Pure (defs + window in, rows out) so it unit-tests
 * without a DB — the same shape as `build-schedule-events.ts` in the workflow.
 *
 * Each occurrence becomes a point-in-time `mark`. Occurrences that fall on the
 * exact same instant (the common case — every reset fires at 06:00 JST, so on a
 * Sunday the daily + weekly resets coincide) are merged into a single mark whose
 * title joins the active reset names, in `sortOrder`. Per-language merged titles
 * are returned alongside for the `translations` table; the calendar then reads
 * them back through the ordinary event-title path.
 */

import { RRuleTemporal } from 'rrule-temporal';
import { Temporal } from 'temporal-polyfill';

import type { NewEvent } from './schema/events';
import type { ResetMilestone } from './schema/reset-milestones';

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
