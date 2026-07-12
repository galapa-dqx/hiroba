/**
 * Translate transcribed image text spans into each target language and store
 * them as per-image `text` translation rows — the exact input localize-images
 * bakes back into the image.
 *
 * The article pipeline gets these rows for free: its `translate` step hydrates
 * each image's Japanese spans into the document and translates them in-context.
 * Banners have no document body, so this step translates their spans directly —
 * one structured call per image per language, kept 1:1 so localize can pair
 * source and target by index. Idempotent: an image already translated to a
 * language is skipped, so re-runs only fill gaps.
 */

import {
  findMatchingGlossaryEntries,
  getImagesByKeys,
  getImageTranslations,
  upsertImageTranslation,
  type Database,
} from '@hiroba/db';
import { collectImages, imageKey, type Block } from '@hiroba/richtext';
import { hasJapanese } from '@hiroba/shared';

import { mapWithConcurrency } from '../concurrency';
import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';
import type { TargetLanguage } from './translate';

const CONCURRENCY = 6;

const SPANS_SCHEMA = {
  type: 'object',
  properties: { texts: { type: 'array', items: { type: 'string' } } },
  required: ['texts'],
  additionalProperties: false,
} as const;

const systemPrompt = (language: string, glossary: string): string =>
  `Translate each Japanese text fragment from a Dragon Quest X promotional banner into natural ${language}, keeping game-specific terms recognizable and strictly adhering to the glossary. Return a JSON object {"texts": [...]} with exactly one translation per input fragment, in the same order — translate each independently; never merge, split, add, or drop fragments.${glossary}`;

/** Translate one image's spans, or null on a bad (non-1:1) round-trip. */
async function translateSpans(
  client: ReturnType<typeof createGemini>,
  spans: string[],
  target: TargetLanguage,
  glossarySection: string,
): Promise<string[] | null> {
  const response = await client.chat.completions.create({
    model: GEMINI_MODEL,
    temperature: 0.3,
    messages: [
      { role: 'system', content: systemPrompt(target.label, glossarySection) },
      { role: 'user', content: JSON.stringify(spans) },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'translations', schema: SPANS_SCHEMA },
    },
  });
  try {
    const parsed = JSON.parse(
      stripCodeFence(response.choices[0]?.message?.content ?? '{}'),
    ) as { texts?: string[] };
    // localize pairs spans by index, so the count must match exactly.
    if (Array.isArray(parsed.texts) && parsed.texts.length === spans.length)
      return parsed.texts;
  } catch {
    // fall through
  }
  return null;
}

export type ImageTextResult = {
  translated: number;
  skipped: number;
  failed: number;
};

/** The image fields this step reads — id plus the transcribed source spans. */
type ImageRow = { id: number; textsJa: string[] | null };

/**
 * Translate one image's transcribed spans into `target` and store the result as
 * its per-image `text` translation row (the exact input localize bakes back into
 * the image). Resolves the glossary from the image's own spans so an edited
 * override lands here. Returns which tally bucket the row fell into.
 */
async function translateImageRow(
  db: Database,
  client: ReturnType<typeof createGemini>,
  row: ImageRow,
  target: TargetLanguage,
): Promise<'translated' | 'skipped' | 'failed'> {
  if (!row.textsJa || !hasJapanese(row.textsJa)) return 'skipped';

  const glossary = await findMatchingGlossaryEntries(
    db,
    row.textsJa.join('\n'),
    target.code,
  );
  const section =
    glossary.length > 0
      ? `\n\nTranslation glossary (use these exact translations):\n${glossary
          .map((g) => `- ${g.sourceText} → ${g.translatedText}`)
          .join('\n')}`
      : '';
  const out = await translateSpans(client, row.textsJa, target, section);
  if (!out) return 'failed';

  await upsertImageTranslation(db, {
    imageId: row.id,
    language: target.code,
    field: 'text',
    value: JSON.stringify(out),
    model: GEMINI_MODEL,
  });
  return 'translated';
}

/**
 * Translate the Japanese text of every image referenced by `blocks` into each
 * target language, writing per-image `text` translation rows. Idempotent: an
 * image already translated to a language is skipped, so re-runs only fill gaps.
 */
export async function translateImageTexts(
  db: Database,
  apiKey: string,
  blocks: Block[],
  targetLanguages: TargetLanguage[],
): Promise<ImageTextResult> {
  const keys = [
    ...new Set(
      collectImages(blocks)
        .map((i) => imageKey(i.src))
        .filter((k): k is string => !!k),
    ),
  ];
  if (keys.length === 0) return { translated: 0, skipped: 0, failed: 0 };

  const rows = await getImagesByKeys(db, keys);
  const client = createGemini(apiKey);
  const result: ImageTextResult = { translated: 0, skipped: 0, failed: 0 };

  for (const target of targetLanguages) {
    const already = await getImageTranslations(
      db,
      rows.map((r) => r.id),
      target.code,
      'text',
    );
    await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      if (already.has(row.id)) {
        result.skipped++;
        return;
      }
      result[await translateImageRow(db, client, row, target)]++;
    });
  }

  return result;
}

/**
 * Re-translate specific images' `text` spans into each target language,
 * unconditionally — no already-translated skip — so an edited glossary override
 * is picked up. Backs the glossary regenerate flow: callers hand it the images
 * whose transcribed Japanese contains the changed term.
 *
 * Only the `text` field is rewritten. The localized image raster (`url` row) is
 * deliberately left untouched: an override edit changes the words we *store for*
 * generation, not the (expensive) picture — a later explicit image regeneration
 * bakes the fresh text in.
 */
export async function retranslateImageTexts(
  db: Database,
  apiKey: string,
  rows: ImageRow[],
  targetLanguages: TargetLanguage[],
): Promise<ImageTextResult> {
  if (rows.length === 0) return { translated: 0, skipped: 0, failed: 0 };

  const client = createGemini(apiKey);
  const result: ImageTextResult = { translated: 0, skipped: 0, failed: 0 };

  for (const target of targetLanguages) {
    await mapWithConcurrency(rows, CONCURRENCY, async (row) => {
      result[await translateImageRow(db, client, row, target)]++;
    });
  }

  return result;
}
