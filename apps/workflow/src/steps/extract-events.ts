/**
 * Extract events step - Use the LLM to extract calendar events from news content.
 *
 * Reads blocks_ja from D1, serializes the block tree to RTML (the same
 * structured input the translate step uses), and calls Gemini with the
 * extraction prompt. The item's publication date is passed as context so the
 * model can resolve bare/relative dates. Each returned event is validated and
 * its dates parsed independently: a malformed or wildly out-of-range event is
 * dropped (not fatal), and the survivors are saved to the events table.
 */

import { eq } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';
import { z } from 'zod';

import { events, newsItems, type Database, type EventType } from '@hiroba/db';
import { serializeToRtml, type Block } from '@hiroba/richtext';

import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';
import type { ExtractEventsResult } from '../types';

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
Extract only if **BOTH** start **and** end date/time (or duration) are explicit in the text.

---

## Not an Event

- Instructions for rewards/bonuses
- Announcements with only start date and no clear end
- Pages mainly explaining how to obtain/apply/enter/redeem/submit
- Codes/applications/redemptions/exchanges/submissions **without explicit deadline or end date**
- Descriptions with vague/undefined end (e.g., "about one year", "around a year", "TBD", "until further notice")

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

### span – continuous period with specific times
\`\`\`json
{
  "type": "span",
  "start": "ISO 8601 timestamp (+09:00)",
  "end": "ISO 8601 timestamp (+09:00)",
  "title": "イベントの説明（日本語）"
}
\`\`\`

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
const multiDayEventSchema = z.object({
  type: z.literal('multiDay'),
  title: z.string(),
  start: jstDate, // YYYY-MM-DD
  end: jstDate, // YYYY-MM-DD
});

const spanEventSchema = z.object({
  type: z.literal('span'),
  title: z.string(),
  start: jstDateTime, // ISO 8601
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

const eventSchema = z.discriminatedUnion('type', [
  multiDayEventSchema,
  spanEventSchema,
  allDayEventSchema,
  markEventSchema,
]);

type ExtractedEvent = z.infer<typeof eventSchema>;

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
 * Generate a unique ID for an event based on its properties.
 */
function generateEventId(event: ExtractedEvent, sourceId: string): string {
  const parts = [sourceId, event.type, event.title];

  if (event.type === 'multiDay' || event.type === 'span') {
    parts.push(event.start.toString(), event.end.toString());
  } else if (event.type === 'allDay') {
    parts.push(event.date.toString());
  } else {
    parts.push(event.timestamp.toString());
  }

  // Simple hash function
  const str = parts.join('|');
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}

const JST_WEEKDAYS = ['月', '火', '水', '木', '金', '土', '日'] as const;

/** Render a publish instant as a compact JST anchor, e.g. "2026-07-01(水) JST". */
function formatPubDate(pub: Temporal.ZonedDateTime): string {
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

/**
 * Assemble the DB row for an extracted event. Date fields are already
 * ZonedDateTime, normalized during validation.
 */
function toDbEvent(
  event: ExtractedEvent,
  sourceId: string,
  now: Temporal.Instant,
): {
  id: string;
  type: EventType;
  titleJa: string;
  startTime: Temporal.ZonedDateTime;
  endTime: Temporal.ZonedDateTime | null;
  sourceType: string;
  sourceId: string;
  createdAt: Temporal.Instant;
} {
  const base = {
    id: generateEventId(event, sourceId),
    titleJa: event.title,
    sourceType: 'news',
    sourceId,
    createdAt: now,
  };
  switch (event.type) {
    case 'multiDay':
      return {
        ...base,
        type: 'multiDay',
        startTime: event.start,
        endTime: event.end,
      };
    case 'span':
      return {
        ...base,
        type: 'span',
        startTime: event.start,
        endTime: event.end,
      };
    case 'allDay':
      return { ...base, type: 'allDay', startTime: event.date, endTime: null };
    case 'mark':
      return {
        ...base,
        type: 'mark',
        startTime: event.timestamp,
        endTime: null,
      };
  }
}

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
  if (!Array.isArray(parsed)) {
    console.error('Event extraction did not return an array:', parsed);
    return [];
  }

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
    out.push(event);
  }
  return out;
}

/**
 * Extract and save events for a news item.
 *
 * @param db - Database client
 * @param apiKey - Gemini API key
 * @param itemId - News item ID
 * @returns Result with count of events extracted and their IDs
 */
export async function extractAndSaveEvents(
  db: Database,
  apiKey: string,
  itemId: string,
): Promise<ExtractEventsResult> {
  // Get the block tree from D1
  const item = await db
    .select({
      titleJa: newsItems.titleJa,
      blocksJa: newsItems.blocksJa,
      publishedAt: newsItems.publishedAt,
    })
    .from(newsItems)
    .where(eq(newsItems.id, itemId))
    .get();

  const blocks = (item?.blocksJa ?? []) as Block[];
  if (!item || blocks.length === 0) {
    console.error(`No content found for item ${itemId}`);
    return { count: 0, eventIds: [] };
  }

  // Feed the LLM the RTML serialization of the block tree — the structure
  // (links, headings, tables) the old plaintext extraction never had.
  const content = serializeToRtml({ title: item.titleJa, blocks });

  // Delete existing events for this source (re-extraction)
  await db.delete(events).where(eq(events.sourceId, itemId));

  // Extract events using the LLM, anchored to the item's publication date so it
  // can resolve bare/relative dates and we can bounds-check the result.
  const pub = item.publishedAt.toZonedDateTimeISO('Asia/Tokyo');
  const extractedEvents = await extractEventsFromContent(content, apiKey, pub);

  if (extractedEvents.length === 0) {
    return { count: 0, eventIds: [] };
  }

  // Convert to database format and insert
  const now = Temporal.Now.instant();
  const eventIds: string[] = [];

  for (const event of extractedEvents) {
    const dbEvent = toDbEvent(event, itemId, now);
    eventIds.push(dbEvent.id);

    await db
      .insert(events)
      .values(dbEvent)
      .onConflictDoUpdate({
        target: [events.id],
        set: {
          type: dbEvent.type,
          titleJa: dbEvent.titleJa,
          startTime: dbEvent.startTime,
          endTime: dbEvent.endTime,
          createdAt: Temporal.Now.instant(),
        },
      });
  }

  return { count: extractedEvents.length, eventIds };
}
