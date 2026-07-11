/**
 * Event resolution — the creation-time dedup that keeps one canonical `events`
 * row per real-world campaign, however many articles mention it.
 *
 * The extractor is an LLM, so "the same campaign" arrives from different
 * articles (and across re-runs) as *almost* the same data — never guaranteed
 * byte-identical. So an event's id is no longer a hash of its content: it is
 * allocated once and thereafter *matched*. Matching is classic entity
 * resolution:
 *
 *   1. Block by time — candidates are existing events whose start sits within a
 *      tolerance of the incoming one (same campaign ⇒ same start, near enough).
 *      Cheap, and the indexed `start_time` keeps the candidate set tiny.
 *   2. Deterministic match — a candidate whose title is equal (after light
 *      normalization) *is* the event. Catches the overwhelming majority: DQX
 *      quotes official campaign names verbatim.
 *   3. Adjudicate the residue — a candidate exists but no title matched exactly.
 *      Hand those to the injected `adjudicate` callback (the workflow backs it
 *      with one batched Gemini call; tests omit it). Storefront/platform
 *      variants must stay distinct; paraphrases of one campaign must merge —
 *      a judgement embeddings get backwards, so it's a reasoning call.
 *
 * Provenance lives in `event_sources` (one row per mentioning article).
 * `events.source_type`/`source_id` holds the *primary* source — the article the
 * calendar links to — recomputed from that set whenever it changes: the source
 * whose own headline actually names the event, oldest wins the tie. That is
 * what stops "Welcome Gift" linking to a version-8 roundup instead of its page.
 *
 * Re-extracting one article only rewrites *that* article's links; a shared
 * event survives as long as any article still references it, and an event left
 * with no sources is swept (with its title translations).
 */

import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import type { Database } from './client';
import {
  events,
  eventSources,
  type Event,
  type EventType,
  type NewEvent,
} from './schema/events';
import { newsItems } from './schema/news-items';
import { topics } from './schema/topics';
import { translations } from './schema/translations';

const ZONE = 'Asia/Tokyo';

/**
 * How far two starts may drift and still be candidates for "the same event".
 * Wide enough to bridge a date-only vs 06:00 rendering of one campaign, narrow
 * enough to keep candidate lists to a handful. Title/adjudication decide within
 * it; time only narrows.
 */
const START_TOLERANCE_MS = 2 * 86_400_000; // 2 days

/** The article source types that flow through resolution (schedule never does). */
type ArticleSource = 'news' | 'topic';

/** An event as produced by extraction — the identity fields, no id/source yet. */
export type ResolvableEvent = {
  type: EventType;
  titleJa: string;
  startTime: Temporal.ZonedDateTime;
  endTime: Temporal.ZonedDateTime | null;
};

/** A residual case: an extracted event with time-candidates but no exact title. */
export type Residual = {
  /** Index into the original extracted array. */
  index: number;
  event: ResolvableEvent;
  candidates: Event[];
};

/**
 * Adjudicates residual matches in one batch. Returns, aligned to `residuals`,
 * the id of the candidate each event *is* (must be one of that residual's own
 * candidate ids), or null to mint a new event. Injected by the caller so this
 * package stays free of any LLM dependency.
 */
export type Adjudicator = (residuals: Residual[]) => Promise<(string | null)[]>;

export type SaveArticleEventsResult = {
  /** Canonical event ids, aligned to the input order (for tag-events' `<event n>`). */
  eventIds: string[];
  /** Events newly minted this call. */
  created: number;
  /** Events resolved onto an existing row (dedup hits). */
  matched: number;
};

export type SaveArticleEventsOptions = {
  adjudicate?: Adjudicator;
  now?: Temporal.Instant;
  /** Override id allocation (tests want deterministic ids). */
  allocateId?: () => string;
};

/** Normalize a title for equality/containment: fold width, drop all spaces. */
function normalizeTitle(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

function titlesEqual(a: string, b: string): boolean {
  return normalizeTitle(a) === normalizeTitle(b);
}

/**
 * Does a source's *headline* name this event? True when either normalized title
 * contains the other — a dedicated "「ゼルメアフィーバー」開催！" page matches, a
 * generic "…情報まとめ" roundup does not. This is the primary-source signal.
 */
function headlineNames(eventTitle: string, sourceTitle: string): boolean {
  const e = normalizeTitle(eventTitle);
  const s = normalizeTitle(sourceTitle);
  return e.length > 0 && s.length > 0 && (s.includes(e) || e.includes(s));
}

function startsClose(aMs: number, bMs: number): boolean {
  return Math.abs(aMs - bMs) <= START_TOLERANCE_MS;
}

/** 64-bit random hex — internal id, never user-facing, collision-negligible. */
function defaultAllocateId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Resolve one article's freshly-extracted events against the existing set and
 * persist: dedup onto existing rows where they match, mint the rest, swap this
 * article's provenance links, sweep orphans, and recompute affected primaries.
 *
 * Not transactional — D1 has no interactive transactions, and the rest of the
 * schema tolerates the same (a partial failure self-heals on the next run or
 * the nightly reconcile). Bound-parameter counts stay tiny: an article yields
 * at most a couple dozen events, well under D1's ~100-param cap, so the IN
 * lists here need no chunking.
 */
export async function saveArticleEvents(
  db: Database,
  sourceType: ArticleSource,
  sourceId: string,
  extracted: ResolvableEvent[],
  opts: SaveArticleEventsOptions = {},
): Promise<SaveArticleEventsResult> {
  const now = opts.now ?? Temporal.Now.instant();
  const allocateId = opts.allocateId ?? defaultAllocateId;

  // The links this source held before — the basis for removals + orphan sweep.
  const priorLinks = await db
    .select()
    .from(eventSources)
    .where(
      and(
        eq(eventSources.sourceType, sourceType),
        eq(eventSources.sourceId, sourceId),
      ),
    )
    .all();
  const priorEventIds = priorLinks.map((l) => l.eventId);

  // Nothing extracted: drop this source's links, sweep now-orphaned events, and
  // let survivors that lost this source recompute their primary.
  if (extracted.length === 0) {
    if (priorEventIds.length > 0) {
      await db
        .delete(eventSources)
        .where(
          and(
            eq(eventSources.sourceType, sourceType),
            eq(eventSources.sourceId, sourceId),
          ),
        );
      await gcOrphans(db, priorEventIds);
      await recomputePrimaries(db, priorEventIds);
    }
    return { eventIds: [], created: 0, matched: 0 };
  }

  // Collapse intra-article duplicates first (the model shouldn't emit them, but
  // if it does, both indices must land on one event). repOf[i] is the earliest
  // index i is a duplicate of. Built imperatively: repOf[j] (j<i) is already set.
  const repOf: number[] = [];
  for (let i = 0; i < extracted.length; i++) {
    let rep = i;
    for (let j = 0; j < i; j++) {
      if (
        titlesEqual(extracted[j].titleJa, extracted[i].titleJa) &&
        startsClose(
          extracted[j].startTime.epochMilliseconds,
          extracted[i].startTime.epochMilliseconds,
        )
      ) {
        rep = repOf[j];
        break;
      }
    }
    repOf.push(rep);
  }

  // Candidate pool: existing article events near the batch's time span. Kept
  // mutable so a freshly-minted event becomes a candidate for later duplicates.
  const startsMs = extracted.map((e) => e.startTime.epochMilliseconds);
  const lo = Temporal.Instant.fromEpochMilliseconds(
    Math.min(...startsMs) - START_TOLERANCE_MS,
  ).toZonedDateTimeISO(ZONE);
  const hi = Temporal.Instant.fromEpochMilliseconds(
    Math.max(...startsMs) + START_TOLERANCE_MS,
  ).toZonedDateTimeISO(ZONE);
  const pool: Event[] = await db
    .select()
    .from(events)
    .where(
      and(
        inArray(events.sourceType, ['news', 'topic']),
        gte(events.startTime, lo),
        lte(events.startTime, hi),
      ),
    )
    .all();

  const candidatesFor = (ev: ResolvableEvent): Event[] => {
    const t = ev.startTime.epochMilliseconds;
    return pool.filter((c) => startsClose(c.startTime.epochMilliseconds, t));
  };

  // resolution[i] = canonical event id for extracted[i] (null until resolved).
  const resolution: (string | null)[] = extracted.map(() => null);
  const residuals: Residual[] = [];

  // Deterministic pass over representatives only.
  extracted.forEach((ev, i) => {
    if (repOf[i] !== i) return; // duplicates inherit their rep after the fact
    const cands = candidatesFor(ev);
    const exact = cands.find((c) => titlesEqual(c.titleJa, ev.titleJa));
    if (exact) {
      resolution[i] = exact.id;
    } else if (cands.length > 0) {
      residuals.push({ index: i, event: ev, candidates: cands });
    }
  });

  // Adjudicate the residue in one batch, if a judge was supplied. Only accept a
  // verdict that names one of that residual's own candidates.
  if (residuals.length > 0 && opts.adjudicate) {
    const verdicts = await opts.adjudicate(residuals);
    residuals.forEach((res, k) => {
      const id = verdicts[k];
      if (id && res.candidates.some((c) => c.id === id)) {
        resolution[res.index] = id;
      }
    });
  }

  // Create pass: every still-unresolved representative mints a new event.
  const created: NewEvent[] = [];
  extracted.forEach((ev, i) => {
    if (repOf[i] !== i || resolution[i] !== null) return;
    const row: NewEvent = {
      id: allocateId(),
      type: ev.type,
      titleJa: ev.titleJa,
      startTime: ev.startTime,
      endTime: ev.endTime,
      sourceType, // provisional primary; recomputed below
      sourceId,
      createdAt: now,
    };
    created.push(row);
    pool.push(row as Event);
    resolution[i] = row.id;
  });
  for (const row of created) {
    await db.insert(events).values(row).onConflictDoNothing();
  }

  // Duplicates inherit their representative's id.
  extracted.forEach((ev, i) => {
    if (repOf[i] !== i) resolution[i] = resolution[repOf[i]];
  });

  // Refresh dates/type when the event's *primary* source re-extracts a match —
  // the owning article was edited (e.g. a campaign extended). A non-primary
  // mention never overwrites the canonical schedule; the title is never touched
  // on a match, so its translation survives.
  const createdIds = new Set(created.map((r) => r.id));
  for (let i = 0; i < extracted.length; i++) {
    if (repOf[i] !== i) continue;
    const id = resolution[i];
    if (!id || createdIds.has(id)) continue;
    const existing = pool.find((e) => e.id === id);
    if (
      existing &&
      existing.sourceType === sourceType &&
      existing.sourceId === sourceId
    ) {
      await db
        .update(events)
        .set({
          type: extracted[i].type,
          startTime: extracted[i].startTime,
          endTime: extracted[i].endTime,
        })
        .where(eq(events.id, id));
    }
  }

  const resolvedIds = [...new Set(resolution.filter((x): x is string => !!x))];

  // Upsert this source's links.
  for (const eventId of resolvedIds) {
    await db
      .insert(eventSources)
      .values({ eventId, sourceType, sourceId, createdAt: now })
      .onConflictDoNothing();
  }

  // Drop links this source no longer supports; sweep any event thereby orphaned.
  const stale = priorEventIds.filter((id) => !resolvedIds.includes(id));
  if (stale.length > 0) {
    await db
      .delete(eventSources)
      .where(
        and(
          eq(eventSources.sourceType, sourceType),
          eq(eventSources.sourceId, sourceId),
          inArray(eventSources.eventId, stale),
        ),
      );
    await gcOrphans(db, stale);
  }

  // Recompute the primary for every event whose source set moved this call.
  await recomputePrimaries(db, [...resolvedIds, ...stale]);

  const matched = resolvedIds.length - created.length;
  return {
    eventIds: resolution as string[],
    created: created.length,
    matched: Math.max(0, matched),
  };
}

/**
 * Delete events (and their title translations) among `ids` that no longer have
 * any provenance link. Article events only ever reach here; schedule events
 * carry no `event_sources` rows and are never passed in.
 */
async function gcOrphans(db: Database, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;

  const stillLinked = await db
    .select({ eventId: eventSources.eventId })
    .from(eventSources)
    .where(inArray(eventSources.eventId, unique))
    .all();
  const linked = new Set(stillLinked.map((r) => r.eventId));
  const orphans = unique.filter((id) => !linked.has(id));
  if (orphans.length === 0) return;

  await db.delete(events).where(inArray(events.id, orphans));
  await db
    .delete(translations)
    .where(
      and(
        eq(translations.itemType, 'event'),
        inArray(translations.itemId, orphans),
      ),
    );
}

/**
 * Recompute the primary source (`events.source_type`/`source_id`) for each id
 * from its current link set: prefer a source whose headline names the event,
 * break ties by oldest publication, then by source id for stability.
 */
async function recomputePrimaries(db: Database, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;

  const eventRows = await db
    .select({ id: events.id, titleJa: events.titleJa })
    .from(events)
    .where(inArray(events.id, unique))
    .all();
  const titleById = new Map(eventRows.map((e) => [e.id, e.titleJa]));

  const links = await db
    .select()
    .from(eventSources)
    .where(inArray(eventSources.eventId, unique))
    .all();
  if (links.length === 0) return;

  // Source metadata (headline + publication) for every referenced article.
  const newsIds = links
    .filter((l) => l.sourceType === 'news')
    .map((l) => l.sourceId);
  const topicIds = links
    .filter((l) => l.sourceType === 'topic')
    .map((l) => l.sourceId);
  const meta = new Map<string, { title: string; publishedMs: number }>();
  const key = (t: string, id: string) => `${t}:${id}`;
  if (newsIds.length > 0) {
    for (const r of await db
      .select({
        id: newsItems.id,
        title: newsItems.titleJa,
        publishedAt: newsItems.publishedAt,
      })
      .from(newsItems)
      .where(inArray(newsItems.id, [...new Set(newsIds)]))
      .all()) {
      meta.set(key('news', r.id), {
        title: r.title,
        publishedMs:
          r.publishedAt?.epochMilliseconds ?? Number.POSITIVE_INFINITY,
      });
    }
  }
  if (topicIds.length > 0) {
    for (const r of await db
      .select({
        id: topics.id,
        title: topics.titleJa,
        publishedAt: topics.publishedAt,
      })
      .from(topics)
      .where(inArray(topics.id, [...new Set(topicIds)]))
      .all()) {
      meta.set(key('topic', r.id), {
        title: r.title,
        publishedMs:
          r.publishedAt?.epochMilliseconds ?? Number.POSITIVE_INFINITY,
      });
    }
  }

  const linksByEvent = new Map<string, typeof links>();
  for (const l of links) {
    const arr = linksByEvent.get(l.eventId) ?? [];
    arr.push(l);
    linksByEvent.set(l.eventId, arr);
  }

  for (const [eventId, evLinks] of linksByEvent) {
    const eventTitle = titleById.get(eventId);
    if (eventTitle === undefined) continue; // GC'd between reads — skip
    const ranked = evLinks
      .map((l) => {
        const m = meta.get(key(l.sourceType, l.sourceId));
        return {
          sourceType: l.sourceType,
          sourceId: l.sourceId,
          names: m ? headlineNames(eventTitle, m.title) : false,
          publishedMs: m?.publishedMs ?? Number.POSITIVE_INFINITY,
        };
      })
      .sort(
        (a, b) =>
          Number(b.names) - Number(a.names) ||
          a.publishedMs - b.publishedMs ||
          a.sourceId.localeCompare(b.sourceId),
      );
    const primary = ranked[0];
    await db
      .update(events)
      .set({ sourceType: primary.sourceType, sourceId: primary.sourceId })
      .where(eq(events.id, eventId));
  }
}

/** Map a stored event row to the resolver's flat shape (for adjudication). */
function toResolvableEvent(e: Event): ResolvableEvent {
  return {
    type: e.type as EventType,
    titleJa: e.titleJa,
    startTime: e.startTime,
    endTime: e.endTime,
  };
}

/** Fold `loser` into `survivor`: move its links, then delete it + translations. */
async function mergeEventInto(
  db: Database,
  survivorId: string,
  loserId: string,
): Promise<void> {
  const loserLinks = await db
    .select()
    .from(eventSources)
    .where(eq(eventSources.eventId, loserId))
    .all();
  for (const l of loserLinks) {
    await db
      .insert(eventSources)
      .values({
        eventId: survivorId,
        sourceType: l.sourceType,
        sourceId: l.sourceId,
        createdAt: l.createdAt,
      })
      .onConflictDoNothing();
  }
  await db.delete(eventSources).where(eq(eventSources.eventId, loserId));
  await db.delete(events).where(eq(events.id, loserId));
  await db
    .delete(translations)
    .where(
      and(eq(translations.itemType, 'event'), eq(translations.itemId, loserId)),
    );
}

/**
 * Nightly reconcile — the safety net creation-time dedup can't cover on its own.
 * Two articles extracted *in parallel* each mint the same campaign before either
 * sees the other; a title that drifts between re-runs slips a fresh row past the
 * matcher. This re-clusters the whole article-event set and folds each cluster
 * onto one survivor, so eventual consistency becomes a feature rather than a race.
 *
 * Same two-tier match as the resolver — deterministic title equality within a
 * time window, then the injected judge for cross-cluster near-misses — run here
 * as a global union-find rather than per-source. The survivor is the oldest row
 * in its cluster (longest-lived id keeps its translations); the rest hand over
 * their links and are deleted. O(n²) over article events, which stays small.
 */
export async function reconcileEvents(
  db: Database,
  opts: { adjudicate?: Adjudicator } = {},
): Promise<{ merged: number }> {
  const rows = await db
    .select()
    .from(events)
    .where(inArray(events.sourceType, ['news', 'topic']))
    .orderBy(asc(events.startTime))
    .all();
  if (rows.length < 2) return { merged: 0 };

  const startMs = rows.map((r) => r.startTime.epochMilliseconds);

  // Union-find; roots bias to the lowest index (earliest start).
  const parent = rows.map((_, i) => i);
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // Tier 1: equal normalized title within the time tolerance.
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < i; j++) {
      if (
        startsClose(startMs[i], startMs[j]) &&
        titlesEqual(rows[i].titleJa, rows[j].titleJa)
      ) {
        union(i, j);
      }
    }
  }

  // Tier 2: hand cross-cluster near-misses (close time, different title) to the
  // judge — one representative per cluster so each is weighed once.
  if (opts.adjudicate) {
    const repByRoot = new Map<number, number>();
    for (let i = 0; i < rows.length; i++) {
      const r = find(i);
      if (!repByRoot.has(r)) repByRoot.set(r, i);
    }
    const reps = [...repByRoot.values()];
    const residuals: Residual[] = [];
    const residualRep: number[] = [];
    for (const i of reps) {
      const candidates = reps
        .filter(
          (j) => find(j) !== find(i) && startsClose(startMs[i], startMs[j]),
        )
        .map((j) => rows[j]);
      if (candidates.length > 0) {
        residuals.push({
          index: residuals.length,
          event: toResolvableEvent(rows[i]),
          candidates,
        });
        residualRep.push(i);
      }
    }
    if (residuals.length > 0) {
      const verdicts = await opts.adjudicate(residuals);
      verdicts.forEach((matchedId, k) => {
        if (!matchedId) return;
        const j = rows.findIndex((r) => r.id === matchedId);
        if (j >= 0) union(residualRep[k], j);
      });
    }
  }

  // Merge each multi-member cluster into its oldest row.
  const clusters = new Map<number, number[]>();
  for (let i = 0; i < rows.length; i++) {
    const r = find(i);
    const arr = clusters.get(r) ?? [];
    arr.push(i);
    clusters.set(r, arr);
  }

  let merged = 0;
  const survivors: string[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    members.sort(
      (a, b) =>
        rows[a].createdAt.epochMilliseconds -
          rows[b].createdAt.epochMilliseconds ||
        rows[a].id.localeCompare(rows[b].id),
    );
    const survivor = rows[members[0]].id;
    survivors.push(survivor);
    for (const m of members.slice(1)) {
      await mergeEventInto(db, survivor, rows[m].id);
      merged++;
    }
  }
  await recomputePrimaries(db, survivors);
  return { merged };
}
