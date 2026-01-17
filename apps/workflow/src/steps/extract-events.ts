/**
 * Extract events step - Use LLM to extract calendar events from news content.
 *
 * Reads contentJa from D1, calls OpenAI with the extraction prompt,
 * parses the response, and saves events to the events table.
 */

import { eq } from 'drizzle-orm';
import OpenAI from 'openai';
import { z } from 'zod';

import { events, newsItems, type Database, type EventType } from '@hiroba/db';

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

// Zod schemas for parsing LLM response
const multiDayEventSchema = z.object({
  type: z.literal('multiDay'),
  title: z.string(),
  start: z.string(), // YYYY-MM-DD
  end: z.string(), // YYYY-MM-DD
});

const spanEventSchema = z.object({
  type: z.literal('span'),
  title: z.string(),
  start: z.string(), // ISO 8601
  end: z.string(), // ISO 8601
});

const allDayEventSchema = z.object({
  type: z.literal('allDay'),
  title: z.string(),
  date: z.string(), // YYYY-MM-DD
});

const markEventSchema = z.object({
  type: z.literal('mark'),
  title: z.string(),
  timestamp: z.string(), // ISO 8601
});

const eventSchema = z.discriminatedUnion('type', [
  multiDayEventSchema,
  spanEventSchema,
  allDayEventSchema,
  markEventSchema,
]);

const eventsArraySchema = z.array(eventSchema);

type ExtractedEvent = z.infer<typeof eventSchema>;

/**
 * Generate a unique ID for an event based on its properties.
 */
function generateEventId(event: ExtractedEvent, sourceId: string): string {
  const parts = [sourceId, event.type, event.title];

  if (event.type === 'multiDay') {
    parts.push(event.start, event.end);
  } else if (event.type === 'span') {
    parts.push(event.start, event.end);
  } else if (event.type === 'allDay') {
    parts.push(event.date);
  } else if (event.type === 'mark') {
    parts.push(event.timestamp);
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

/**
 * Convert extracted event to database format.
 */
function toDbEvent(
  event: ExtractedEvent,
  sourceId: string,
  now: number,
): {
  id: string;
  type: EventType;
  titleJa: string;
  startTime: string;
  endTime: string | null;
  sourceType: string;
  sourceId: string;
  createdAt: number;
} {
  const id = generateEventId(event, sourceId);

  if (event.type === 'multiDay') {
    return {
      id,
      type: 'multiDay',
      titleJa: event.title,
      startTime: event.start,
      endTime: event.end,
      sourceType: 'news',
      sourceId,
      createdAt: now,
    };
  } else if (event.type === 'span') {
    return {
      id,
      type: 'span',
      titleJa: event.title,
      startTime: event.start,
      endTime: event.end,
      sourceType: 'news',
      sourceId,
      createdAt: now,
    };
  } else if (event.type === 'allDay') {
    return {
      id,
      type: 'allDay',
      titleJa: event.title,
      startTime: event.date,
      endTime: null,
      sourceType: 'news',
      sourceId,
      createdAt: now,
    };
  } else {
    // mark
    return {
      id,
      type: 'mark',
      titleJa: event.title,
      startTime: event.timestamp,
      endTime: null,
      sourceType: 'news',
      sourceId,
      createdAt: now,
    };
  }
}

/**
 * Extract events from content using OpenAI.
 */
async function extractEventsFromContent(
  content: string,
  apiKey: string,
): Promise<ExtractedEvent[]> {
  const client = new OpenAI({ apiKey });

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.1,
    messages: [
      { role: 'system', content: EXTRACTION_PROMPT },
      { role: 'user', content },
    ],
  });

  const responseText = response.choices[0]?.message?.content ?? '[]';

  // Try to extract JSON array from response
  let jsonText = responseText.trim();

  // Handle markdown code blocks
  if (jsonText.startsWith('```')) {
    const lines = jsonText.split('\n');
    // Remove first line (```json or ```)
    lines.shift();
    // Remove last line (```)
    if (lines[lines.length - 1]?.trim() === '```') {
      lines.pop();
    }
    jsonText = lines.join('\n').trim();
  }

  try {
    const parsed = JSON.parse(jsonText) as unknown;
    const result = eventsArraySchema.safeParse(parsed);

    if (result.success) {
      return result.data;
    } else {
      console.error('Event validation failed:', result.error);
      return [];
    }
  } catch (error) {
    console.error('Failed to parse events JSON:', error);
    return [];
  }
}

/**
 * Extract and save events for a news item.
 *
 * @param db - Database client
 * @param apiKey - OpenAI API key
 * @param itemId - News item ID
 * @returns Result with count of events extracted and their IDs
 */
export async function extractAndSaveEvents(
  db: Database,
  apiKey: string,
  itemId: string,
): Promise<ExtractEventsResult> {
  // Get the content from D1
  const item = await db
    .select({
      contentJa: newsItems.contentJa,
    })
    .from(newsItems)
    .where(eq(newsItems.id, itemId))
    .get();

  if (!item?.contentJa) {
    console.error(`No content found for item ${itemId}`);
    return { count: 0, eventIds: [] };
  }

  // Delete existing events for this source (re-extraction)
  await db.delete(events).where(eq(events.sourceId, itemId));

  // Extract events using LLM
  const extractedEvents = await extractEventsFromContent(item.contentJa, apiKey);

  if (extractedEvents.length === 0) {
    return { count: 0, eventIds: [] };
  }

  // Convert to database format and insert
  const now = Math.floor(Date.now() / 1000);
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
          createdAt: now,
        },
      });
  }

  return { count: extractedEvents.length, eventIds };
}
