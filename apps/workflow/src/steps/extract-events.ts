/**
 * Extract events step - Use the LLM to extract calendar events from an article
 * (news item or topic).
 *
 * Reads blocks_ja from D1, serializes the block tree to RTML (the same
 * structured input the translate step uses), and calls Gemini with the
 * extraction prompt. The item's publication date is passed as context so the
 * model can resolve bare/relative dates. Each returned event is validated and
 * its dates parsed independently: a malformed or wildly out-of-range event is
 * dropped (not fatal), and the survivors are saved to the events table.
 */

import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';

import {
  saveArticleEvents,
  type Database,
  type ResolvableEvent,
} from '@hiroba/db';
import {
  serializeToRtml,
  stripTimeEventTags,
  type Block,
} from '@hiroba/richtext';

import { getArticle } from '../article';
import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';
import type { ExtractEventsResult, ItemType } from '../types';
import { createEventAdjudicator } from './adjudicate-events';

// Event extraction prompt (loaded inline to avoid file system reads in worker)
const EXTRACTION_PROMPT = `# Event Extraction

Given a **Japanese blog article**, extract **all explicitly stated events** (no duplicates) per the **event schema below**, returning results **in Japanese**.

- Extract only events **explicitly present in the text**.
- **Do not infer, reinterpret, or supplement information.**
- Scan the **entire article**; extract only events that are **specific and uniquely identifiable**.

---

## "Event" Definition

Extract only items meeting at least one criterion:

### A) Scheduled activities
Planned, ongoing, or scheduled for a **specific date/time** where users can participate, attend, view, experience, or conduct.
(e.g., live streams, gatherings, maintenance, in-game events)

### B) Time-bounded campaigns/updates/features/maintenance
Extract if the **end** date/time (or duration) is explicit in the text.
- If the start is also explicit, use it.
- If the text gives **only a deadline/end** (e.g. 「〜まで」「配布期間 … まで」「プレゼント期間 … まで」) and the period is implicitly already underway, set \`"start"\` to the literal string \`"publishedAt"\` — the article's publication moment. **Never invent a start date.**
- **One event per named campaign.** When one campaign lists multiple numbered
  benefits or sub-rewards (キャンペーン①／②, 特典1／特典2), each with its own
  period, extract a **single** event titled with the campaign name, spanning the
  widest stated period. Never emit per-benefit events.

---

## Not an Event

- Instructions for rewards/bonuses
- Announcements with only start date and no clear end
- Pages mainly explaining how to obtain/apply/enter/redeem/submit
- Codes/applications/redemptions/exchanges/submissions **without explicit deadline or end date**
- Descriptions with vague/undefined end (e.g., "about one year", "around a year", "TBD", "until further notice"). This includes ends pinned to an **undated future release**: 「次回大型アップデートまで」「次回アップデートメンテナンス開始まで」 — no real date exists, so it is not an event.
- **Standing programs**, *even with a stated end date*: membership/enrollment offers, credit-card sign-ups (e.g. 「…VISAカード」新規入会キャンペーン), point/loyalty programs, ongoing monthly perks (毎月利用特典). A far-off end is a renewal boundary, not an event.
- **Account/data procedures**: data transfer, save-data carry-over, account linking (引継ぎ, データ移行, アカウント連携) — a how-to with a deadline, not something to attend.
- **Support / troubleshooting notices**: inquiries, known issues, outages and their recovery (お問い合わせ, 不具合, 障害, 復旧) — status announcements, not scheduled activities. (Genuine *scheduled* maintenance with an explicit start/end **is** an event.)

If end date or period is unclear/missing, **do not extract**.

---

## Time Handling

- The article's **publication date** is given in the \`<pubdate>\` tag at the top of the input (JST).
- Resolve every date that omits a year, and every relative date (本日, 明日, 今週, 来週, 毎週○曜日, …), **relative to that publication date**.
- Unless the text clearly indicates otherwise, assume events occur **on or after** the publication date — e.g. a bare "1月5日" in a late-December post means the following January.
- Default: **JST (UTC+09:00)**.
- Convert all times to **ISO 8601 with \`+09:00\`**.
- Use other timezone if explicitly indicated.
- Date ranges without times: use \`multiDay\` event type with date-only strings.
- Exclude times that don't map to real-world time (e.g., in-game clocks).

---

## Critical Decomposition (MANDATORY)

#### Single-day, multiple-time
If ALL:
- Single explicit date
- Multiple distinct times that are separate events (not continuous)

Then:
1. Output **one \`allDay\` event** for that date, using event name as written.
2. Output **one \`mark\` event per time**.
3. **Never combine into \`span\`** in these cases.

---

## Event Types

### multiDay – spans multiple calendar days
Use for events that span multiple calendar days without specific times.
\`\`\`json
{
  "type": "multiDay",
  "start": "YYYY-MM-DD",
  "end": "YYYY-MM-DD",
  "title": "イベント名（日本語）"
}
\`\`\`
\`"start"\` may be the literal string \`"publishedAt"\` when only the end is stated.

### span – continuous period with specific times
\`\`\`json
{
  "type": "span",
  "start": "ISO 8601 timestamp (+09:00)",
  "end": "ISO 8601 timestamp (+09:00)",
  "title": "イベントの説明（日本語）"
}
\`\`\`
\`"start"\` may be the literal string \`"publishedAt"\` when only the end is stated (deadline-only periods like 「…5:59 まで」).

### allDay – all-day event
\`\`\`json
{
  "type": "allDay",
  "date": "YYYY-MM-DD (JST)",
  "title": "イベント名（日本語）"
}
\`\`\`

### mark – specific moment
\`\`\`json
{
  "type": "mark",
  "timestamp": "ISO 8601 timestamp (+09:00)",
  "title": "特定の時間の説明（日本語）"
}
\`\`\`

---

## Output Rules

- Output: JSON array of event objects only
- No explanations, comments, metadata, or extra text
- Use only required keys per event type
- If no valid events: output exactly \`[]\``;

// Parse the LLM's date/timestamp strings into Tokyo-zoned Temporal values during
// validation, so a malformed value (e.g. from a hallucinated year) fails its own
// event in safeParse instead of throwing downstream when we build the DB row.
const jstDate = z.string().transform((s, ctx) => {
  try {
    return Temporal.PlainDate.from(s).toZonedDateTime('Asia/Tokyo');
  } catch {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unparseable date "${s}"`,
    });
    return z.NEVER;
  }
});

// ISO 8601 with an explicit offset (the prompt asks for +09:00).
// ZonedDateTime.from() rejects an offset-only string — it wants an [IANA]
// annotation too — so parse the offset via Instant and project onto the Tokyo
// wall clock, falling back to treating a bare local time as JST.
const jstDateTime = z.string().transform((s, ctx) => {
  try {
    return Temporal.Instant.from(s).toZonedDateTimeISO('Asia/Tokyo');
  } catch {
    try {
      return Temporal.PlainDateTime.from(s).toZonedDateTime('Asia/Tokyo');
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `unparseable timestamp "${s}"`,
      });
      return z.NEVER;
    }
  }
});

// Zod schemas for parsing the LLM response (dates normalized to ZonedDateTime).
// Built per-article: `start` fields also accept the literal sentinel
// "publishedAt" (deadline-only periods — 「…まで」 — whose period is already
// underway at publication), which resolves to the article's publication moment
// so the model never has to invent a start.
function buildEventSchema(pub: Temporal.ZonedDateTime) {
  const pubDay = pub.toPlainDate().toZonedDateTime('Asia/Tokyo');
  const jstDateOrPub = z.union([
    z.literal('publishedAt').transform(() => pubDay),
    jstDate,
  ]);
  const jstDateTimeOrPub = z.union([
    z.literal('publishedAt').transform(() => pub),
    jstDateTime,
  ]);

  const multiDayEventSchema = z.object({
    type: z.literal('multiDay'),
    title: z.string(),
    start: jstDateOrPub, // YYYY-MM-DD | "publishedAt"
    end: jstDate, // YYYY-MM-DD
  });

  const spanEventSchema = z.object({
    type: z.literal('span'),
    title: z.string(),
    start: jstDateTimeOrPub, // ISO 8601 | "publishedAt"
    end: jstDateTime, // ISO 8601
  });

  const allDayEventSchema = z.object({
    type: z.literal('allDay'),
    title: z.string(),
    date: jstDate, // YYYY-MM-DD
  });

  const markEventSchema = z.object({
    type: z.literal('mark'),
    title: z.string(),
    timestamp: jstDateTime, // ISO 8601
  });

  return z.discriminatedUnion('type', [
    multiDayEventSchema,
    spanEventSchema,
    allDayEventSchema,
    markEventSchema,
  ]);
}

type ExtractedEvent = z.infer<ReturnType<typeof buildEventSchema>>;

/** The start instant of an event, whatever its type — its calendar anchor. */
function eventStart(event: ExtractedEvent): Temporal.ZonedDateTime {
  switch (event.type) {
    case 'multiDay':
    case 'span':
      return event.start;
    case 'allDay':
      return event.date;
    case 'mark':
      return event.timestamp;
  }
}

/**
 * Flatten an extracted event to the resolver's shape — the four type variants
 * collapse to a common `{startTime, endTime}` pair. Identity (id) and provenance
 * (source, primary) are the resolver's job now, not a source-scoped hash.
 */
function toResolvable(event: ExtractedEvent): ResolvableEvent {
  switch (event.type) {
    case 'multiDay':
    case 'span':
      return {
        type: event.type,
        titleJa: event.title,
        startTime: event.start,
        endTime: event.end,
      };
    case 'allDay':
      return {
        type: 'allDay',
        titleJa: event.title,
        startTime: event.date,
        endTime: null,
      };
    case 'mark':
      return {
        type: 'mark',
        titleJa: event.title,
        startTime: event.timestamp,
        endTime: null,
      };
  }
}

const JST_WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'] as const;

/** Render a publish instant as a compact JST anchor, e.g. "2026-07-01(水) JST". */
export function formatPubDate(pub: Temporal.ZonedDateTime): string {
  // Temporal dayOfWeek is 1 (Mon) .. 7 (Sun).
  return `${pub.toPlainDate().toString()}(${JST_WEEKDAYS[pub.dayOfWeek - 1]}) JST`;
}

// Sanity window for an extracted date relative to the publication date. A year-off
// inference (the common failure when the article omits the year) lands far outside
// it; legitimate announcements sit within. Wide on purpose — this only catches
// egregiously wrong dates, not merely surprising ones.
const DAY_MS = 86_400_000;
const MAX_DAYS_BEFORE_PUB = 180; // events rarely predate their own announcement
const MAX_DAYS_AFTER_PUB = 540; // ~18 months out

// Backstop for the "standing program" the prompt tells the model to skip
// (credit-card enrollment, membership, point programs): those run for the better
// part of a year, real time-boxed campaigns rarely past ~2 months. 180 days sits
// well above any legitimate campaign in the archive and below the 8-month
// enrollment offers, so it only trips on things that aren't really events.
const MAX_EVENT_DURATION_DAYS = 180;

/**
 * Extract events from RTML content using Gemini, anchored to the publication
 * date. Each event is validated and bounds-checked independently, so one bad
 * element (an unparseable or wildly out-of-range date) drops only itself rather
 * than discarding the whole batch.
 */
async function extractEventsFromContent(
  content: string,
  apiKey: string,
  pub: Temporal.ZonedDateTime,
): Promise<ExtractedEvent[]> {
  const client = createGemini(apiKey);

  const response = await client.chat.completions.create({
    model: GEMINI_MODEL,
    temperature: 0.1,
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      {
        role: 'user',
        content: `<pubdate>${formatPubDate(pub)}</pubdate>\n${content}`,
      },
    ],
  });

  const responseText = response.choices[0]?.message?.content ?? '[]';
  const jsonText = stripCodeFence(responseText) || '[]';

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    console.error('Failed to parse events JSON:', error);
    return [];
  }
  return parseExtractedEvents(parsed, pub);
}

/**
 * Validate and bounds-check a raw (JSON-parsed) LLM response. Exported for
 * tests; pure apart from console warnings.
 */
export function parseExtractedEvents(
  parsed: unknown,
  pub: Temporal.ZonedDateTime,
): ExtractedEvent[] {
  if (!Array.isArray(parsed)) {
    console.error('Event extraction did not return an array:', parsed);
    return [];
  }

  const eventSchema = buildEventSchema(pub);
  const pubEpoch = pub.epochMilliseconds;
  const out: ExtractedEvent[] = [];
  for (const raw of parsed) {
    const result = eventSchema.safeParse(raw);
    if (!result.success) {
      console.warn(
        `Dropping invalid event: ${result.error.issues
          .map((i) => i.message)
          .join('; ')}`,
      );
      continue;
    }
    const event = result.data;
    const offsetDays =
      (eventStart(event).epochMilliseconds - pubEpoch) / DAY_MS;
    if (offsetDays < -MAX_DAYS_BEFORE_PUB || offsetDays > MAX_DAYS_AFTER_PUB) {
      console.warn(
        `Dropping out-of-range event (${Math.round(offsetDays)}d from publication, likely wrong year): ${event.title}`,
      );
      continue;
    }
    // The start alone no longer proves the range sane: a sentinel start is
    // trivially in range while the model may still hallucinate the end's year.
    if (event.type === 'multiDay' || event.type === 'span') {
      const endOffsetDays = (event.end.epochMilliseconds - pubEpoch) / DAY_MS;
      if (
        Temporal.ZonedDateTime.compare(event.end, event.start) < 0 ||
        endOffsetDays > MAX_DAYS_AFTER_PUB
      ) {
        console.warn(
          `Dropping event with implausible end (${Math.round(endOffsetDays)}d from publication): ${event.title}`,
        );
        continue;
      }
      const durationDays =
        (event.end.epochMilliseconds - event.start.epochMilliseconds) / DAY_MS;
      if (durationDays > MAX_EVENT_DURATION_DAYS) {
        console.warn(
          `Dropping over-long event (${Math.round(durationDays)}d — likely a standing program, not an event): ${event.title}`,
        );
        continue;
      }
    }
    out.push(event);
  }
  return out;
}

/**
 * Extract and save events for an article (news item or topic).
 *
 * @param db - Database client
 * @param apiKey - Gemini API key
 * @param itemType - 'news' | 'topic' (also the event's source_type)
 * @param itemId - Source item ID
 * @returns Result with count of events extracted and their IDs
 */
export async function extractAndSaveEvents(
  db: Database,
  apiKey: string,
  itemType: ItemType,
  itemId: string,
): Promise<ExtractEventsResult> {
  // Get the block tree from D1 (news item or topic — same body shape).
  const item = await getArticle(db, itemType, itemId);

  // On re-runs blocks_ja may already carry time/event annotations from a prior
  // tag-events pass — strip them so extraction always sees the plain article.
  const blocks = stripTimeEventTags((item?.blocksJa ?? []) as Block[]);
  if (!item || blocks.length === 0) {
    console.error(`No content found for ${itemType} ${itemId}`);
    return { count: 0, eventIds: [] };
  }

  // Only news/topics carry dated events; playguides are gated out upstream, but
  // guard here too since the resolver is typed to article sources.
  if (itemType === 'playguide') {
    return { count: 0, eventIds: [] };
  }

  // Feed the LLM the RTML serialization of the block tree — the structure
  // (links, headings, tables) the old plaintext extraction never had.
  const content = serializeToRtml({ title: item.titleJa, blocks });

  // Extract events using the LLM, anchored to the item's publication date so it
  // can resolve bare/relative dates and we can bounds-check the result. (Only
  // dated types reach here — playguides skip event extraction — so publishedAt
  // is present; fall back to now for the type-checker.)
  const pub = (item.publishedAt ?? Temporal.Now.instant()).toZonedDateTimeISO(
    'Asia/Tokyo',
  );
  const extractedEvents = await extractEventsFromContent(content, apiKey, pub);

  // Resolve against the existing set and persist: dedup onto shared rows, mint
  // the rest, swap this article's provenance links, sweep orphans. Passing an
  // empty list is meaningful — it clears this source's events on a re-run that
  // now finds none. The Gemini-backed judge only fires on residual near-matches.
  const result = await saveArticleEvents(
    db,
    itemType,
    itemId,
    extractedEvents.map(toResolvable),
    { adjudicate: createEventAdjudicator(apiKey) },
  );

  return { count: result.eventIds.length, eventIds: result.eventIds };
}
