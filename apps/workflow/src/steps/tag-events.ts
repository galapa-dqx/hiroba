/**
 * Tag events step — annotate the article's JA block tree with inline `<time>`
 * and `<event>` tags (pass 2 of event handling; extract-events is pass 1).
 *
 * The LLM receives the RTML serialization of blocks_ja plus the events already
 * extracted and saved by extract-events (as a numbered list), and returns the
 * same RTML with only two kinds of inline tags inserted:
 *
 *   • `<time datetime="…">…</time>` around each literal timestamp phrase — the
 *     model writes the machine value (per-mention, JST rules as extraction).
 *   • `<event n="N">…</event>` around each event's dated phrase — the model
 *     only references the event by its list index; code resolves `n` to the
 *     saved row's id/start/end before parsing, so ids and event timestamps are
 *     never model-written.
 *
 * The result is trusted only if stripping the new tags reproduces the original
 * tree byte-for-byte in canonical RTML (tagsPreserveContent). On failure we
 * retry once, then fall through untagged — annotation is best-effort, the
 * article content is not negotiable. Tagging runs before the translate step so
 * blocks_en inherits the tags through the translation round-trip.
 */

import { inArray } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import { events, type Database } from '@hiroba/db';
import {
  countTimeEventTags,
  parseRtml,
  serializeToRtml,
  stripTimeEventTags,
  tagsPreserveContent,
  type Block,
} from '@hiroba/richtext';

import { getArticle, saveArticleBlocks } from '../article';
import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';
import type { ItemType, TagEventsResult } from '../types';
import { formatPubDate } from './extract-events';

const TAGGING_PROMPT = `# Timestamp & Event Annotation

You are given a Japanese article in a compact HTML-like markup (RTML), preceded by a \`<pubdate>\` tag and an \`<eventlist>\` of calendar events already extracted from it.

Return the **exact same markup**, with only two kinds of inline tags inserted:

### 1. \`<time datetime="…">\` — every explicit timestamp
Wrap every human-readable date/time phrase in the body text:
\`\`\`
<time datetime="2026-07-13T05:59:00+09:00">2026年7月13日（月） 5:59</time>
\`\`\`
- \`datetime\` is ISO 8601 with \`+09:00\` (JST is the default timezone; use another offset only if the text says so).
- Resolve missing years and relative dates (本日, 明日, …) against \`<pubdate>\`; assume dates fall on or after publication unless the text says otherwise.
- A date without a time gets a date-only value: \`datetime="2026-07-13"\`.
- Skip vague periods ("近日", "しばらく"), durations, and times that aren't real-world moments (in-game clocks).

### 2. \`<event n="N">\` — each listed event's dated phrase
For each event in \`<eventlist>\`, wrap the **one** phrase that states the event and its date(s) — label and timestamps together where they are contiguous:
\`\`\`
<event n="1">プレゼント期間 <time datetime="2026-07-13T05:59:00+09:00">2026年7月13日（月） 5:59</time> まで</event>
\`\`\`
- \`n\` is the event's number in \`<eventlist>\`. Use each \`n\` at most once, at the event's primary mention.
- Nest \`<time>\` tags inside the \`<event>\` around the literal timestamps.
- If an event has no single contiguous phrase (its title and dates sit in different table cells, for example), **skip it** — do not stretch a tag across unrelated text.

## Hard rules
- Change NOTHING else: no text edits, no reflowing, no added/removed/reordered tags or attributes, no whitespace changes.
- Only insert \`<time>\` and \`<event>\` tags, always with matching close tags around non-empty text. Never self-close them, never leave them empty.
- Never insert tags inside \`<doctitle>\`.
- Output the annotated article markup only, beginning at \`<doctitle>\`. Do NOT repeat the \`<pubdate>\` or \`<eventlist>\` context, add no explanations, and use no code fences.`;

/** The event-row fields the tagging pass needs (exported for tests). */
export type TaggableEvent = {
  id: string;
  type: string;
  titleJa: string;
  startTime: Temporal.ZonedDateTime;
  endTime: Temporal.ZonedDateTime | null;
};

/** Attribute rendering: date-only for date-granularity types, ISO+offset else. */
function eventAttrValue(type: string, zdt: Temporal.ZonedDateTime): string {
  return type === 'multiDay' || type === 'allDay'
    ? zdt.toPlainDate().toString()
    : zdt.toString({ timeZoneName: 'never' });
}

/** One `<eventlist>` line, e.g. `1. [span] プレゼント期間 — 2026-07-01T12:00:00+09:00 → 2026-07-13T05:59:00+09:00`. */
function formatEventLine(n: number, row: TaggableEvent): string {
  const start = eventAttrValue(row.type, row.startTime);
  const end = row.endTime ? ` → ${eventAttrValue(row.type, row.endTime)}` : '';
  return `${n}. [${row.type}] ${row.titleJa} — ${start}${end}`;
}

/**
 * Replace every model-written `<event n="N">` with the saved row's real
 * attributes. Returns null when any reference is unknown or any `<event>` tag
 * escaped the strict `n` form — the whole attempt is then discarded (the model
 * is never allowed to author ids or event timestamps itself).
 */
export function resolveEventRefs(
  rtml: string,
  rows: TaggableEvent[],
): string | null {
  let ok = true;
  const resolved = rtml.replace(
    /<event\s+n="(\d+)"\s*>/g,
    (_m, nStr: string) => {
      const row = rows[Number(nStr) - 1];
      if (!row) {
        ok = false;
        return '';
      }
      const start = eventAttrValue(row.type, row.startTime);
      const end = row.endTime
        ? ` end="${eventAttrValue(row.type, row.endTime)}"`
        : '';
      return `<event id="${row.id}" start="${start}"${end}>`;
    },
  );
  // Any surviving <event …> that is not one we just wrote means the model
  // strayed from the n="N" form (self-closed, single quotes, own attrs…).
  if (!ok || /<event\b(?!\s+id=")/.test(resolved)) return null;
  return resolved;
}

/**
 * Peel the `<pubdate>`/`<eventlist>` context tags off the model's reply. Both
 * are prepended to the article the model is asked to echo back, so it routinely
 * repeats them ahead of the `<doctitle>` — and parseRtml would then throw on the
 * unknown top-level tag. Strip any leading occurrences (either order); the real
 * document begins at `<doctitle>`.
 */
export function stripTaggingScaffold(raw: string): string {
  const lead =
    /^(?:<pubdate>[\s\S]*?<\/pubdate>|<eventlist>[\s\S]*?<\/eventlist>)\s*/i;
  let out = raw.replace(/^\s+/, '');
  for (
    let next = out.replace(lead, '');
    next !== out;
    next = out.replace(lead, '')
  )
    out = next;
  return out;
}

/** True when any time/event node carries an empty machine value. */
function hasInvalidTagAttrs(blocks: Block[]): boolean {
  let bad = false;
  const visit = (v: unknown): void => {
    if (bad) return;
    if (Array.isArray(v)) {
      v.forEach(visit);
      return;
    }
    if (v !== null && typeof v === 'object') {
      const n = v as Record<string, unknown>;
      if (n.type === 'time' && !n.datetime) bad = true;
      if (n.type === 'event' && (!n.id || !n.start)) bad = true;
      Object.values(n).forEach(visit);
    }
  };
  visit(blocks);
  return bad;
}

/**
 * Annotate an article's blocks_ja with time/event tags, best-effort.
 *
 * @param eventIds - ids saved by the extract-events step (its run order fixes
 *   the `n` numbering shown to the model)
 */
export async function tagArticleEvents(
  db: Database,
  apiKey: string,
  itemType: ItemType,
  itemId: string,
  eventIds: string[],
): Promise<TagEventsResult> {
  const item = await getArticle(db, itemType, itemId);
  const stored = (item?.blocksJa ?? []) as Block[];
  if (!item || stored.length === 0) {
    return { tagged: false, timeTags: 0, eventTags: 0, retried: false };
  }

  // Idempotency: re-runs start from the untagged tree.
  const original = stripTimeEventTags(stored);

  // Zero events is fine — <time> annotation alone is still worthwhile.
  const rows =
    eventIds.length > 0
      ? await db
          .select({
            id: events.id,
            type: events.type,
            titleJa: events.titleJa,
            startTime: events.startTime,
            endTime: events.endTime,
          })
          .from(events)
          .where(inArray(events.id, eventIds))
          .all()
      : [];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = eventIds
    .map((id) => byId.get(id))
    .filter((r): r is TaggableEvent => r !== undefined);

  // Only dated types reach here (playguides skip tagging), so publishedAt is
  // present; fall back to now to satisfy the nullable-union type-checker.
  const pub = (item.publishedAt ?? Temporal.Now.instant()).toZonedDateTimeISO(
    'Asia/Tokyo',
  );
  const eventList = ordered
    .map((row, i) => formatEventLine(i + 1, row))
    .join('\n');
  const userContent =
    `<pubdate>${formatPubDate(pub)}</pubdate>\n` +
    `<eventlist>\n${eventList}\n</eventlist>\n` +
    serializeToRtml({ title: item.titleJa, blocks: original });

  const client = createGemini(apiKey);
  let retried = false;

  for (let attempt = 0; attempt < 2; attempt++) {
    retried = attempt > 0;
    const response = await client.chat.completions.create({
      model: GEMINI_MODEL,
      temperature: 0,
      messages: [
        { role: 'system', content: TAGGING_PROMPT },
        { role: 'user', content: userContent },
      ],
    });
    const raw = stripTaggingScaffold(
      stripCodeFence(response.choices[0]?.message?.content ?? ''),
    );

    const resolved = resolveEventRefs(raw, ordered);
    if (resolved === null) {
      console.warn(`tag-events ${itemType} ${itemId}: bad <event n> reference`);
      continue;
    }
    let tagged: Block[];
    try {
      tagged = parseRtml(resolved).blocks;
    } catch (err) {
      console.warn(`tag-events ${itemType} ${itemId}: unparseable markup`, err);
      continue;
    }
    if (hasInvalidTagAttrs(tagged)) {
      console.warn(`tag-events ${itemType} ${itemId}: empty tag attribute`);
      continue;
    }
    if (!tagsPreserveContent(original, tagged)) {
      console.warn(
        `tag-events ${itemType} ${itemId}: tagging altered content, discarding`,
      );
      continue;
    }

    const counts = countTimeEventTags(tagged);
    // Skip the write when the model found nothing and the stored tree was
    // already untagged (the common no-dates case).
    const storedCounts = countTimeEventTags(stored);
    if (
      counts.timeTags + counts.eventTags > 0 ||
      storedCounts.timeTags + storedCounts.eventTags > 0
    ) {
      await saveArticleBlocks(db, itemType, itemId, tagged);
    }
    return { tagged: true, ...counts, retried };
  }

  // Both attempts failed. Extract-events re-created the event rows this run, so
  // any tags surviving from a previous run may reference deleted ids — persist
  // the stripped tree rather than leave them dangling.
  const storedCounts = countTimeEventTags(stored);
  if (storedCounts.timeTags + storedCounts.eventTags > 0) {
    await saveArticleBlocks(db, itemType, itemId, original);
  }
  return { tagged: false, timeTags: 0, eventTags: 0, retried };
}
