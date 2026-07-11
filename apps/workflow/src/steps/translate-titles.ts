/**
 * Title translation chunk (DQX-11) — the reusable unit the TitleWorkflow runs as
 * a durable, retried step. Translates one chunk of titles for one language in a
 * single LLM call: a JSON array of `{id, title}` in → the same shape out, with
 * the chunk's matching glossary injected. Matching is by id, so a reordered
 * response still lines up. Each title is stepped through its translations-row
 * states (running → done) like the full translate step.
 *
 * A transport/API error is left to throw so the enclosing workflow step retries
 * the chunk (that durability is the whole reason titles run in a workflow now
 * that discovery no longer kicks off the full ArticleWorkflow). A *partial* miss
 * — the call succeeded but the model dropped an id — is not thrown: that title
 * is reset to `pending` (first view or the backfill will pick it up) so one
 * straggler doesn't force the whole chunk to re-translate. `pending`, not
 * `failed`, because the snapshot aggregates title+content and a failed title
 * with no content row yet would read the whole translation phase as terminally
 * failed.
 */

import {
  findMatchingGlossaryEntries,
  getLanguageLabel,
  setTranslationStates,
  upsertItemTranslation,
  type Database,
  type ItemType,
} from '@hiroba/db';

import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';

/**
 * Max titles per LLM call (one workflow step). Titles are short, so this isn't a
 * token limit — it bounds each request, caps the blast radius of a single
 * dropped/garbled response, and keeps a retried step small. Steady-state hourly
 * batches are well under this, so they stay one call.
 */
export const TITLE_BATCH_SIZE = 25;

const systemPrompt = (language: string) =>
  `Translate each Japanese article title to natural ${language}, keeping Dragon Quest X game-specific terms recognizable and strictly adhering to the translation glossary. You are given a JSON array of {"id","title"} objects. Respond with ONLY a JSON array of the same objects with each title replaced by its ${language} translation, preserving every id. No other text.`;

/** Render matching glossary entries as a prompt section (empty when none match). */
function glossarySection(
  entries: ReadonlyArray<{ sourceText: string; translatedText: string }>,
): string {
  if (entries.length === 0) return '';
  return `\n\nTranslation glossary (use these exact translations):\n${entries
    .map((g) => `- ${g.sourceText} → ${g.translatedText}`)
    .join('\n')}`;
}

/**
 * Parse the batch response into an id → translated-title map. Tolerant of a
 * mangled response: entries without a string id/title (or a blank title) are
 * dropped, and ids the model omitted simply never appear (the caller resets
 * those to `pending`). Exported for testing.
 */
export function parseTitleBatch(raw: string): Map<string, string> {
  const out = new Map<string, string>();
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return out;
  }
  if (!Array.isArray(data)) return out;
  for (const entry of data) {
    if (
      entry &&
      typeof entry === 'object' &&
      'id' in entry &&
      'title' in entry
    ) {
      const { id, title } = entry as { id: unknown; title: unknown };
      if (typeof id === 'string' && typeof title === 'string' && title.trim()) {
        out.set(id, title.trim());
      }
    }
  }
  return out;
}

/**
 * Translate one chunk of titles for one language. Meant to run inside a workflow
 * step, so a transport error throws (the step retries); returns per-title
 * success/failure counts on a completed call.
 *
 * @param db - Database client
 * @param apiKey - Gemini API key
 * @param itemType - 'news' | 'topic'
 * @param language - target language (e.g. 'en')
 * @param chunk - the titles to translate ({id, titleJa})
 */
export async function translateTitleChunk(
  db: Database,
  apiKey: string,
  itemType: Exclude<ItemType, 'image'>,
  language: string,
  chunk: ReadonlyArray<{ id: string; titleJa: string }>,
): Promise<{ translated: number; failed: number }> {
  if (chunk.length === 0) return { translated: 0, failed: 0 };

  // Claim the chunk's title rows as `running` (creating them) — the stepped
  // lifecycle, and it marks the work in flight for any concurrent reader.
  for (const item of chunk) {
    await setTranslationStates(db, {
      itemType,
      itemId: item.id,
      language,
      fields: ['title'],
      state: 'running',
    });
  }

  // No try/catch around the call: a transport/API error propagates so the
  // workflow step retries the whole chunk.
  const client = createGemini(apiKey);
  const label = await getLanguageLabel(db, language);
  const glossary = await findMatchingGlossaryEntries(
    db,
    chunk.map((i) => i.titleJa).join('\n'),
    language,
  );
  const response = await client.chat.completions.create({
    model: GEMINI_MODEL,
    temperature: 0.3,
    messages: [
      {
        role: 'system',
        content: systemPrompt(label) + glossarySection(glossary),
      },
      {
        role: 'user',
        content: JSON.stringify(
          chunk.map((i) => ({ id: i.id, title: i.titleJa })),
        ),
      },
    ],
  });
  const byId = parseTitleBatch(
    stripCodeFence(response.choices[0]?.message?.content ?? ''),
  );

  let translated = 0;
  let failed = 0;
  for (const item of chunk) {
    const value = byId.get(item.id);
    if (value) {
      await upsertItemTranslation(db, {
        itemType,
        itemId: item.id,
        language,
        field: 'title',
        value,
        model: GEMINI_MODEL,
      });
      translated++;
    } else {
      await setTranslationStates(db, {
        itemType,
        itemId: item.id,
        language,
        fields: ['title'],
        state: 'pending',
      });
      failed++;
    }
  }
  return { translated, failed };
}
