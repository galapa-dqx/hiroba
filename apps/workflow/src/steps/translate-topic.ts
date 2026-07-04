/**
 * Translate-topic step — whole-document JA→EN translation of a topic.
 *
 * Image text is transcribed into the `images` table (deduped per image). Here we
 * hydrate each image's spans back into the block tree so they translate
 * in-context via `<figure>` — but only for images that have Japanese and aren't
 * already translated to the target language (a shared banner is translated once,
 * by the first topic to include it). After translating we pull the EN spans out
 * into per-image translation rows (item_type='image', field='text') and strip
 * them from the stored topic content, which therefore carries no image text.
 *
 * On a bad round-trip it leaves the topic in JA (the renderer falls back to
 * blocks_ja).
 */

import {
  collectImages,
  imageKey,
  parseTranslation,
  serializeForTranslation,
  type Block,
} from '@hiroba/richtext';
import {
  findMatchingGlossaryEntries,
  getImagesByKeys,
  getTopic,
  getTranslatedImageIds,
  upsertImageTranslation,
  upsertTopicTranslation,
  type Database,
} from '@hiroba/db';

import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';
import type { TranslateResult } from '../types';

const TARGET_LANGUAGE = 'en';

const TRANSLATION_SYSTEM_PROMPT =
  'Translate the provided article from Japanese to natural English, maintaining formatting and matching the original tone, while strictly adhering to the translation glossary. Retain all HTML tags in the output.';

const JAPANESE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f]/;
const hasJapanese = (spans: string[]): boolean => spans.some((s) => JAPANESE.test(s));

/**
 * Translate a topic and save its EN title + content, plus per-image EN text.
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

  // Hydrate image text from the images table, injecting spans only for localizable
  // images not already translated to the target language.
  const blockImages = collectImages(blocks);
  const keys = [...new Set(blockImages.map((i) => imageKey(i.src)).filter((k): k is string => !!k))];
  const imageRows = await getImagesByKeys(db, keys);
  const byKey = new Map(imageRows.map((r) => [r.key, r]));
  const alreadyTranslated = await getTranslatedImageIds(db, imageRows.map((r) => r.id), TARGET_LANGUAGE);

  for (const img of blockImages) {
    const key = imageKey(img.src);
    const row = key ? byKey.get(key) : undefined;
    if (row?.textsJa && hasJapanese(row.textsJa) && !alreadyTranslated.has(row.id)) {
      img.text = row.textsJa;
    } else {
      delete img.text;
    }
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

  // Pull the translated image spans out into per-image translation rows. The two
  // trees share structure, so images line up by index.
  const enImages = collectImages(result.blocks);
  if (enImages.length === blockImages.length) {
    for (let i = 0; i < blockImages.length; i++) {
      if (!blockImages[i].text?.length) continue; // wasn't injected → not (re)translated
      const key = imageKey(blockImages[i].src);
      const row = key ? byKey.get(key) : undefined;
      const enSpans = enImages[i].text;
      if (row && enSpans?.length) {
        await upsertImageTranslation(db, {
          imageId: row.id,
          language: TARGET_LANGUAGE,
          field: 'text',
          value: JSON.stringify(enSpans),
          model: GEMINI_MODEL,
        });
      }
    }
  }

  // Image text is transient in the tree — its home is images/translations.
  for (const img of enImages) delete img.text;

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
