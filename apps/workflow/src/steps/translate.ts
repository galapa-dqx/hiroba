/**
 * Translate step - Bulk translate news content and event titles.
 *
 * Uses CSV-based bulk translation for efficiency:
 * - Loads glossary terms matching the content
 * - Builds CSV input with all texts to translate
 * - Calls LLM for bulk translation
 * - Parses CSV output and saves to translations table
 */

import { parse } from 'csv-parse/sync';
import { eq, inArray } from 'drizzle-orm';
import OpenAI from 'openai';

import {
  events,
  findMatchingGlossaryEntries,
  newsItems,
  translations,
  type Database,
} from '@hiroba/db';

import type { TranslateResult } from '../types';

const TARGET_LANGUAGE = 'en';

const TRANSLATION_SYSTEM_PROMPT = `You are a professional translator specializing in Japanese video game content, particularly Dragon Quest X (DQX) online game.

Your task is to translate Japanese text to natural English. You will receive a CSV with texts to translate.

Guidelines:
- Keep game-specific terms, item names, location names, and character names that players would recognize
- Preserve any formatting like bullet points, numbered lists, dates, and times
- Convert Japanese date/time formats to be internationally readable while keeping original values
- Keep URLs and technical identifiers unchanged
- Maintain the original tone (official announcements should sound official)
- If there are instructions or steps, ensure they remain clear and actionable

Input CSV format:
id,type,text
1,title,"Japanese title here"
2,content,"Japanese content here"
3,event_title,"Event name in Japanese"

Output CSV format (respond ONLY with CSV, no explanations):
id,translatedText
1,"Translated title"
2,"Translated content"
3,"Translated event name"

IMPORTANT: Respond with ONLY the CSV output, no markdown code blocks or explanations.`;

type TranslationRow = {
  id: string;
  type: 'title' | 'content' | 'event_title';
  itemType: 'news' | 'event';
  itemId: string;
  text: string;
};

/**
 * Escape a value for CSV format.
 */
function escapeCsvValue(value: string): string {
  // Always quote and escape internal quotes
  const escaped = value.replace(/"/g, '""');
  return `"${escaped}"`;
}

/**
 * Parse a CSV response using csv-parse.
 */
function parseCsvResponse(csv: string): Map<string, string> {
  const result = new Map<string, string>();

  const records = parse(csv.trim(), {
    columns: true,
    skip_empty_lines: true,
    relax_quotes: true,
  }) as Array<{ id: string; translatedText: string }>;

  for (const record of records) {
    if (record.id && record.translatedText) {
      result.set(record.id, record.translatedText);
    }
  }

  return result;
}

/**
 * Build CSV input for translation.
 */
function buildCsvInput(rows: TranslationRow[]): string {
  const lines = ['id,type,text'];

  for (const row of rows) {
    lines.push(`${row.id},${row.type},${escapeCsvValue(row.text)}`);
  }

  return lines.join('\n');
}

/**
 * Translate texts using OpenAI with CSV format.
 */
async function translateWithCsv(
  rows: TranslationRow[],
  glossaryText: string,
  apiKey: string,
): Promise<Map<string, string>> {
  const client = new OpenAI({ apiKey });

  const csvInput = buildCsvInput(rows);

  const glossarySection =
    glossaryText.length > 0
      ? `\n\nGlossary (use these exact translations):\n${glossaryText}`
      : '';

  const response = await client.chat.completions.create({
    model: 'gpt-4o',
    temperature: 0.3,
    messages: [
      { role: 'system', content: TRANSLATION_SYSTEM_PROMPT + glossarySection },
      { role: 'user', content: csvInput },
    ],
  });

  const responseText = response.choices[0]?.message?.content ?? '';

  // Strip any markdown code blocks if present
  let csvText = responseText.trim();
  if (csvText.startsWith('```')) {
    const lines = csvText.split('\n');
    lines.shift(); // Remove opening ```
    if (lines[lines.length - 1]?.trim() === '```') {
      lines.pop();
    }
    csvText = lines.join('\n').trim();
  }

  return parseCsvResponse(csvText);
}

/**
 * Translate and save translations for a news item and its events.
 *
 * @param db - Database client
 * @param apiKey - OpenAI API key
 * @param itemId - News item ID
 * @param eventIds - IDs of events to translate
 * @returns Result with success status and count of fields translated
 */
export async function translateAndSave(
  db: Database,
  apiKey: string,
  itemId: string,
  eventIds: string[],
): Promise<TranslateResult> {
  // Get news item
  const item = await db
    .select({
      titleJa: newsItems.titleJa,
      contentJa: newsItems.contentJa,
    })
    .from(newsItems)
    .where(eq(newsItems.id, itemId))
    .get();

  if (!item) {
    console.error(`News item ${itemId} not found`);
    return { success: false, fieldsTranslated: 0 };
  }

  // Get events
  const eventRows =
    eventIds.length > 0
      ? await db
          .select({
            id: events.id,
            titleJa: events.titleJa,
          })
          .from(events)
          .where(inArray(events.id, eventIds))
          .all()
      : [];

  // Build translation rows
  const rows: TranslationRow[] = [];
  let rowId = 1;

  // Add title
  rows.push({
    id: String(rowId++),
    type: 'title',
    itemType: 'news',
    itemId,
    text: item.titleJa,
  });

  // Add content if exists
  if (item.contentJa) {
    rows.push({
      id: String(rowId++),
      type: 'content',
      itemType: 'news',
      itemId,
      text: item.contentJa,
    });
  }

  // Add event titles
  for (const event of eventRows) {
    rows.push({
      id: String(rowId++),
      type: 'event_title',
      itemType: 'event',
      itemId: event.id,
      text: event.titleJa,
    });
  }

  if (rows.length === 0) {
    return { success: true, fieldsTranslated: 0 };
  }

  // Combine all texts for glossary matching
  const combinedText = rows.map((r) => r.text).join(' ');
  const glossaryTerms = await findMatchingGlossaryEntries(
    db,
    combinedText,
    TARGET_LANGUAGE,
  );

  // Build glossary text
  const glossaryText = glossaryTerms
    .map((t) => `- ${t.sourceText} → ${t.translatedText}`)
    .join('\n');

  // Translate via LLM
  const translationMap = await translateWithCsv(rows, glossaryText, apiKey);

  // Save translations to D1
  const now = Math.floor(Date.now() / 1000);
  const model = 'gpt-4o';
  let fieldsTranslated = 0;

  for (const row of rows) {
    const translatedText = translationMap.get(row.id);
    if (!translatedText) {
      console.warn(`No translation found for row ${row.id}`);
      continue;
    }

    const field = row.type === 'event_title' ? 'title' : row.type;

    await db
      .insert(translations)
      .values({
        itemType: row.itemType,
        itemId: row.itemId,
        language: TARGET_LANGUAGE,
        field,
        value: translatedText,
        translatedAt: now,
        model,
      })
      .onConflictDoUpdate({
        target: [
          translations.itemType,
          translations.itemId,
          translations.language,
          translations.field,
        ],
        set: {
          value: translatedText,
          translatedAt: now,
          model,
        },
      });

    fieldsTranslated++;
  }

  return { success: true, fieldsTranslated };
}
