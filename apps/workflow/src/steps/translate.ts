/**
 * Translate step — JA→EN translation of a news item and its event titles.
 *
 * The news body translates as a whole document via the RTML round-trip
 * (serializeForTranslation → Gemini → parseTranslation), the same path topics
 * use: the title and block tree translate together and the EN block tree is
 * stored as the news `content` translation (JSON). Event titles are short
 * strings, translated one at a time.
 *
 * This retires the old gpt-4o CSV batch, whose row-misalignment failure mode
 * silently swapped translations; a bad RTML round-trip instead fails loudly and
 * leaves the item in Japanese (the renderer falls back to blocks_ja).
 */

import { eq, inArray } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  events,
  findMatchingGlossaryEntries,
  newsItems,
  setTranslationStates,
  translations,
  type Database,
} from '@hiroba/db';
import {
  parseTranslation,
  reconcileAttributes,
  serializeForTranslation,
  type Block,
} from '@hiroba/richtext';

import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';
import type { TranslateResult } from '../types';
import { logReconciliation } from './reconcile-log';

const TARGET_LANGUAGE = 'en';

const BODY_SYSTEM_PROMPT =
  'Translate the provided article from Japanese to natural English, maintaining formatting and matching the original tone, while strictly adhering to the translation glossary. Retain all HTML tags in the output.';

const TITLE_SYSTEM_PROMPT =
  'Translate the Japanese text to natural English, keeping Dragon Quest X game-specific terms recognizable and strictly adhering to the translation glossary. Respond with ONLY the translated text — no quotes, labels, or explanations.';

/** Render matching glossary entries as a prompt section (empty when none match). */
function glossarySection(
  entries: ReadonlyArray<{ sourceText: string; translatedText: string }>,
): string {
  if (entries.length === 0) return '';
  return `\n\nTranslation glossary (use these exact translations):\n${entries
    .map((g) => `- ${g.sourceText} → ${g.translatedText}`)
    .join('\n')}`;
}

/** Upsert a single news/event translation row (item_type='news'|'event'). */
async function upsertTranslation(
  db: Database,
  params: {
    itemType: 'news' | 'event';
    itemId: string;
    field: 'title' | 'content';
    value: string;
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  await db
    .insert(translations)
    .values({
      itemType: params.itemType,
      itemId: params.itemId,
      language: TARGET_LANGUAGE,
      field: params.field,
      state: 'done',
      value: params.value,
      translatedAt: now,
      model: GEMINI_MODEL,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        translations.itemType,
        translations.itemId,
        translations.language,
        translations.field,
      ],
      set: {
        state: 'done',
        error: null,
        value: params.value,
        translatedAt: now,
        model: GEMINI_MODEL,
        updatedAt: now,
      },
    });
}

/**
 * Translate and save translations for a news item and its events.
 *
 * @param db - Database client
 * @param apiKey - Gemini API key
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
  const item = await db
    .select({
      titleJa: newsItems.titleJa,
      blocksJa: newsItems.blocksJa,
    })
    .from(newsItems)
    .where(eq(newsItems.id, itemId))
    .get();

  if (!item) {
    console.error(`News item ${itemId} not found`);
    return { success: false, fieldsTranslated: 0 };
  }

  const client = createGemini(apiKey);
  let fieldsTranslated = 0;

  // 1. Translate the news document (title + body) via the RTML whole-doc path.
  const blocks = (item.blocksJa ?? []) as Block[];
  if (blocks.length > 0) {
    await setTranslationStates(db, {
      itemType: 'news',
      itemId,
      language: TARGET_LANGUAGE,
      fields: ['title', 'content'],
      state: 'running',
    });
    const markup = serializeForTranslation({ title: item.titleJa, blocks });
    const glossary = await findMatchingGlossaryEntries(
      db,
      `${item.titleJa}\n${markup}`,
      TARGET_LANGUAGE,
    );

    const response = await client.chat.completions.create({
      model: GEMINI_MODEL,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: BODY_SYSTEM_PROMPT + glossarySection(glossary),
        },
        { role: 'user', content: markup },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '';
    let result: { title: string; blocks: Block[] } | null = null;
    try {
      result = parseTranslation(stripCodeFence(raw));
    } catch (err) {
      console.error(`News ${itemId}: failed to parse translated markup`, err);
      await setTranslationStates(db, {
        itemType: 'news',
        itemId,
        language: TARGET_LANGUAGE,
        fields: ['title', 'content'],
        state: 'failed',
        error: 'failed to parse translated markup',
      });
    }

    // A mangled response that parses to an empty body → keep JA.
    if (result && result.blocks.length > 0) {
      // The LLM is only meant to rewrite text; restore any non-linguistic
      // attribute (image/link URLs, colors, variants…) it drifted from the JA.
      logReconciliation(
        `News ${itemId}`,
        reconcileAttributes(blocks, result.blocks),
      );
      await upsertTranslation(db, {
        itemType: 'news',
        itemId,
        field: 'title',
        value: result.title || item.titleJa,
      });
      await upsertTranslation(db, {
        itemType: 'news',
        itemId,
        field: 'content',
        value: JSON.stringify(result.blocks),
      });
      fieldsTranslated += 2;
    } else if (result) {
      console.error(`News ${itemId}: translated body was empty, keeping JA`);
      await setTranslationStates(db, {
        itemType: 'news',
        itemId,
        language: TARGET_LANGUAGE,
        fields: ['title', 'content'],
        state: 'failed',
        error: 'translated body was empty',
      });
    }
  }

  // 2. Translate event titles (short strings; one call each keeps them aligned).
  const eventRows =
    eventIds.length > 0
      ? await db
          .select({ id: events.id, titleJa: events.titleJa })
          .from(events)
          .where(inArray(events.id, eventIds))
          .all()
      : [];

  for (const event of eventRows) {
    const glossary = await findMatchingGlossaryEntries(
      db,
      event.titleJa,
      TARGET_LANGUAGE,
    );
    const response = await client.chat.completions.create({
      model: GEMINI_MODEL,
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content: TITLE_SYSTEM_PROMPT + glossarySection(glossary),
        },
        { role: 'user', content: event.titleJa },
      ],
    });
    const translated = stripCodeFence(
      response.choices[0]?.message?.content ?? '',
    ).trim();
    if (!translated) {
      console.warn(`No translation returned for event ${event.id}`);
      continue;
    }
    await upsertTranslation(db, {
      itemType: 'event',
      itemId: event.id,
      field: 'title',
      value: translated,
    });
    fieldsTranslated++;
  }

  return { success: true, fieldsTranslated };
}
