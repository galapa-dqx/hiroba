/**
 * Translate step — whole-document translation of an article (news or topic)
 * from Japanese into every enabled target language, plus its image text and
 * event titles.
 *
 * For each language, the title and block tree translate together via the RTML
 * round-trip (serializeForTranslation → Gemini → parseTranslation); the
 * translated block tree is stored as the article's `content` translation
 * (JSON).
 *
 * Image text is transcribed into the `images` table (deduped per image). Here
 * we hydrate each image's spans back into the block tree so they translate
 * in-context via `<figure>` — but only for images that have Japanese and
 * aren't already translated to the target language (a shared banner is
 * translated once, by the first article to include it). After translating we
 * pull the translated spans out into per-image translation rows
 * (item_type='image', field='text') and strip them from the stored content.
 * News references no images, so the image work is a no-op there.
 *
 * Event titles are short strings, translated one at a time to keep them
 * aligned.
 *
 * On a bad round-trip it leaves that language's body in JA (the renderer falls
 * back to blocks_ja); other languages and event titles still translate
 * independently.
 */

import { inArray } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import {
  events,
  findMatchingGlossaryEntries,
  getImagesByKeys,
  getTranslatedImageIds,
  setTranslationStates,
  translations,
  upsertImageTranslation,
  type Database,
} from '@hiroba/db';
import {
  collectImages,
  imageKey,
  parseTranslation,
  reconcileAttributes,
  serializeForTranslation,
  stripTimeEventTags,
  type Block,
} from '@hiroba/richtext';
import { hasJapanese } from '@hiroba/shared';

import { getArticle } from '../article';
import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';
import type { ItemType, TranslateResult } from '../types';
import { logReconciliation } from './reconcile-log';

/** A translation target: the code keys the rows, the label goes in prompts. */
export type TargetLanguage = { code: string; label: string };

const bodySystemPrompt = (language: string) =>
  `Translate the provided article from Japanese to natural ${language}, maintaining formatting and matching the original tone, while strictly adhering to the translation glossary. Retain the HTML tags from the input, but never introduce a tag that was not already there — the only tags in your output are ones copied from the source. Text sometimes wraps a word in full-width brackets （＜ ＞, 【 】, 《 》） or literal angle brackets; these are ordinary characters, so reproduce them verbatim and never turn them into a tag or add a closing tag (keep ＜片手剣＞ as ＜sword＞ or &lt;sword&gt;, never <sword>). Keep <time> and <event> tags in place around the corresponding translated phrases and copy their attributes verbatim.`;

const titleSystemPrompt = (language: string) =>
  `Translate the Japanese text to natural ${language}, keeping Dragon Quest X game-specific terms recognizable and strictly adhering to the translation glossary. Respond with ONLY the translated text — no quotes, labels, or explanations.`;

/** Render matching glossary entries as a prompt section (empty when none match). */
function glossarySection(
  entries: ReadonlyArray<{ sourceText: string; translatedText: string }>,
): string {
  if (entries.length === 0) return '';
  return `\n\nTranslation glossary (use these exact translations):\n${entries
    .map((g) => `- ${g.sourceText} → ${g.translatedText}`)
    .join('\n')}`;
}

/** Upsert a single article/event translation row (item_type='news'|'topic'|'event'). */
async function upsertTranslation(
  db: Database,
  params: {
    itemType: 'news' | 'topic' | 'event';
    itemId: string;
    language: string;
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
      language: params.language,
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
 * Translate the article document (title + body) into one language via the RTML
 * whole-doc path, storing title/content rows and per-image span rows.
 * Returns the number of fields written (0 on a failed round-trip).
 */
async function translateBody(
  db: Database,
  client: ReturnType<typeof createGemini>,
  itemType: ItemType,
  itemId: string,
  item: { titleJa: string },
  blocks: Block[],
  target: TargetLanguage,
): Promise<number> {
  const language = target.code;
  await setTranslationStates(db, {
    itemType,
    itemId,
    language,
    fields: ['title', 'content'],
    state: 'running',
  });

  // Hydrate image text from the images table, injecting spans only for
  // localizable images not already translated to the target language. No-op
  // for news (no images).
  const blockImages = collectImages(blocks);
  const keys = [
    ...new Set(
      blockImages.map((i) => imageKey(i.src)).filter((k): k is string => !!k),
    ),
  ];
  const imageRows = await getImagesByKeys(db, keys);
  const byKey = new Map(imageRows.map((r) => [r.key, r]));
  const alreadyTranslated = await getTranslatedImageIds(
    db,
    imageRows.map((r) => r.id),
    language,
  );
  for (const img of blockImages) {
    const key = imageKey(img.src);
    const row = key ? byKey.get(key) : undefined;
    if (
      row?.textsJa &&
      hasJapanese(row.textsJa) &&
      !alreadyTranslated.has(row.id)
    ) {
      img.text = row.textsJa;
    } else {
      delete img.text;
    }
  }

  const markup = serializeForTranslation({ title: item.titleJa, blocks });
  const glossary = await findMatchingGlossaryEntries(
    db,
    `${item.titleJa}\n${markup}`,
    language,
  );

  const response = await client.chat.completions.create({
    model: GEMINI_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: bodySystemPrompt(target.label) + glossarySection(glossary),
      },
      { role: 'user', content: markup },
    ],
  });

  const raw = response.choices[0]?.message?.content ?? '';
  let result: { title: string; blocks: Block[] } | null = null;
  try {
    result = parseTranslation(stripCodeFence(raw));
  } catch (err) {
    console.error(
      `${itemType} ${itemId}: failed to parse translated markup (${language})`,
      err,
    );
    await setTranslationStates(db, {
      itemType,
      itemId,
      language,
      fields: ['title', 'content'],
      state: 'failed',
      error: 'failed to parse translated markup',
    });
    return 0;
  }

  // A mangled response that parses to an empty body → keep JA.
  if (!result || result.blocks.length === 0) {
    console.error(
      `${itemType} ${itemId}: translated body was empty (${language}), keeping JA`,
    );
    await setTranslationStates(db, {
      itemType,
      itemId,
      language,
      fields: ['title', 'content'],
      state: 'failed',
      error: 'translated body was empty',
    });
    return 0;
  }

  // The LLM is only meant to rewrite text; restore any non-linguistic
  // attribute (image/link URLs, colors, variants…) it drifted from the JA.
  const report = reconcileAttributes(blocks, result.blocks);
  logReconciliation(`${itemType} ${itemId} (${language})`, report);

  // Time/event annotations pair the JA and translated trees by index; if the
  // translation added or dropped one, the surviving attrs can't be trusted
  // (an unrepaired id may point anywhere) — strip them from the tree.
  if (
    report.divergences.some(
      (d) => d.nodeType === 'time' || d.nodeType === 'event',
    )
  ) {
    console.warn(
      `${itemType} ${itemId}: time/event tags diverged in translation (${language}), stripping`,
    );
    result.blocks = stripTimeEventTags(result.blocks);
  }

  // Pull the translated image spans out into per-image translation rows. The
  // two trees share structure, so images line up by index.
  const translatedImages = collectImages(result.blocks);
  if (translatedImages.length === blockImages.length) {
    for (let i = 0; i < blockImages.length; i++) {
      if (!blockImages[i].text?.length) continue; // wasn't injected → not (re)translated
      const key = imageKey(blockImages[i].src);
      const row = key ? byKey.get(key) : undefined;
      const spans = translatedImages[i].text;
      if (row && spans?.length) {
        await upsertImageTranslation(db, {
          imageId: row.id,
          language,
          field: 'text',
          value: JSON.stringify(spans),
          model: GEMINI_MODEL,
        });
      }
    }
  }
  // Image text is transient in the tree — its home is images/translations.
  for (const img of translatedImages) delete img.text;

  await upsertTranslation(db, {
    itemType,
    itemId,
    language,
    field: 'title',
    value: result.title || item.titleJa,
  });
  await upsertTranslation(db, {
    itemType,
    itemId,
    language,
    field: 'content',
    value: JSON.stringify(result.blocks),
  });
  return 2;
}

/**
 * Translate and save translations for an article (news item or topic) and its
 * events, in every target language.
 *
 * @param db - Database client
 * @param apiKey - Gemini API key
 * @param itemType - 'news' | 'topic'
 * @param itemId - Source item ID
 * @param eventIds - IDs of events (from the extract-events step) to translate
 * @param targetLanguages - the enabled languages to translate into
 * @returns Result with body-translation success and count of fields translated
 */
export async function translateArticle(
  db: Database,
  apiKey: string,
  itemType: ItemType,
  itemId: string,
  eventIds: string[],
  targetLanguages: TargetLanguage[],
): Promise<TranslateResult> {
  const item = await getArticle(db, itemType, itemId);
  if (!item) {
    console.error(`${itemType} ${itemId} not found`);
    return { success: false, fieldsTranslated: 0 };
  }

  const client = createGemini(apiKey);
  let fieldsTranslated = 0;

  // 1. Translate the article document (title + body), language by language.
  const blocks = (item.blocksJa ?? []) as Block[];
  let bodyOk = blocks.length > 0;
  if (blocks.length > 0) {
    for (const target of targetLanguages) {
      const written = await translateBody(
        db,
        client,
        itemType,
        itemId,
        item,
        blocks,
        target,
      );
      fieldsTranslated += written;
      if (written === 0) bodyOk = false;
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

  for (const target of targetLanguages) {
    for (const event of eventRows) {
      const glossary = await findMatchingGlossaryEntries(
        db,
        event.titleJa,
        target.code,
      );
      const response = await client.chat.completions.create({
        model: GEMINI_MODEL,
        temperature: 0.3,
        messages: [
          {
            role: 'system',
            content:
              titleSystemPrompt(target.label) + glossarySection(glossary),
          },
          { role: 'user', content: event.titleJa },
        ],
      });
      const translated = stripCodeFence(
        response.choices[0]?.message?.content ?? '',
      ).trim();
      if (!translated) {
        console.warn(
          `No translation returned for event ${event.id} (${target.code})`,
        );
        continue;
      }
      await upsertTranslation(db, {
        itemType: 'event',
        itemId: event.id,
        language: target.code,
        field: 'title',
        value: translated,
      });
      fieldsTranslated++;
    }
  }

  return { success: bodyOk, fieldsTranslated };
}
