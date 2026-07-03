/**
 * Translate-topic step — whole-document JA→EN translation of a topic.
 *
 * Serializes the title + body as one `<title>…</title><article>…</article>`
 * document (so the model sees full context and can adjust the title once it has
 * read the body), sends it to Gemini 3.1 Flash Lite with matching glossary terms,
 * parses the translated markup back to a block tree, and stores the EN title +
 * content in the translations table. On a bad round-trip it leaves the topic in
 * JA (the renderer falls back to blocks_ja).
 */

import { parseTranslation, serializeForTranslation, type Block } from '@hiroba/richtext';
import { findMatchingGlossaryEntries, getTopic, upsertTopicTranslation, type Database } from '@hiroba/db';

import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';
import type { TranslateResult } from '../types';

const TARGET_LANGUAGE = 'en';

const TRANSLATION_SYSTEM_PROMPT =
  'Translate the provided article from Japanese to natural English, maintaining formatting and matching the original tone, while strictly adhering to the translation glossary. Retain all HTML tags in the output.';

/**
 * Translate a topic and save its EN title + content.
 *
 * @param db - Database client
 * @param apiKey - Gemini API key
 * @param topicId - Topic ID (its blocks_ja must already be populated)
 */
export async function translateTopic(db: Database, apiKey: string, topicId: string): Promise<TranslateResult> {
  const topic = await getTopic(db, topicId);
  if (!topic) {
    console.error(`Topic ${topicId} not found`);
    return { success: false, fieldsTranslated: 0 };
  }
  const blocks = (topic.blocksJa ?? []) as Block[];
  if (blocks.length === 0) {
    console.error(`Topic ${topicId} has no blocks to translate`);
    return { success: false, fieldsTranslated: 0 };
  }

  const markup = serializeForTranslation({ title: topic.titleJa, blocks });

  const glossary = await findMatchingGlossaryEntries(db, `${topic.titleJa}\n${markup}`, TARGET_LANGUAGE);
  const glossarySection =
    glossary.length > 0
      ? `\n\nTranslation glossary (use these exact translations):\n${glossary
          .map((g) => `- ${g.sourceText} → ${g.translatedText}`)
          .join('\n')}`
      : '';

  const client = createGemini(apiKey);
  const response = await client.chat.completions.create({
    model: GEMINI_MODEL,
    temperature: 0.3,
    messages: [
      { role: 'system', content: TRANSLATION_SYSTEM_PROMPT + glossarySection },
      { role: 'user', content: markup },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';

  let result: { title: string; blocks: Block[] };
  try {
    result = parseTranslation(stripCodeFence(raw));
  } catch (err) {
    console.error(`Topic ${topicId}: failed to parse translated markup`, err);
    return { success: false, fieldsTranslated: 0 };
  }

  // Fallback: a mangled response that parses to an empty body → keep JA.
  if (result.blocks.length === 0) {
    console.error(`Topic ${topicId}: translated body was empty, keeping JA`);
    return { success: false, fieldsTranslated: 0 };
  }

  await upsertTopicTranslation(db, {
    itemId: topicId,
    language: TARGET_LANGUAGE,
    field: 'title',
    value: result.title || topic.titleJa,
    model: GEMINI_MODEL,
  });
  await upsertTopicTranslation(db, {
    itemId: topicId,
    language: TARGET_LANGUAGE,
    field: 'content',
    value: JSON.stringify(result.blocks),
    model: GEMINI_MODEL,
  });

  return { success: true, fieldsTranslated: 2 };
}
