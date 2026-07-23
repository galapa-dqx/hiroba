/**
 * Image-source queries, co-located with the image_sources schema (DQX-51):
 * discovery (ensure rows exist), transcription/mirror state, the transcription
 * upsert, the admin span-restructure edit, and the key lookup that fans the
 * pipeline out (the most-shared read in the package).
 */

import { and, eq, inArray } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Temporal } from 'temporal-polyfill';

import type { PhaseState } from '@hiroba/shared';

import type { Database } from '../client';
import { chunked } from '../d1-limits';
import { imageSources, type ImageSource } from './image-sources';
import { translations } from './translations';

/**
 * Ensure an image-source row exists for every key, so the pipeline has rows to
 * hang transcription state (and renders) on. Existing rows (any state) are left
 * untouched.
 */
export async function ensureImageSourceRows(
  db: Database,
  keys: string[],
): Promise<void> {
  const now = Temporal.Now.instant();
  // Batched inserts: each row binds several parameters, so keep batches small
  // enough to stay under D1's per-statement cap.
  const ROWS_PER_INSERT = 20;
  for (let i = 0; i < keys.length; i += ROWS_PER_INSERT) {
    await db
      .insert(imageSources)
      .values(
        keys
          .slice(i, i + ROWS_PER_INSERT)
          .map((key) => ({ key, updatedAt: now })),
      )
      .onConflictDoNothing();
  }
}

/** Set the transcription state on an image-source row (running/failed transitions). */
export async function setImageTranscribeState(
  db: Database,
  key: string,
  state: Exclude<PhaseState, 'done'>, // 'done' lands with texts via upsertImageTranscription
): Promise<void> {
  await db
    .update(imageSources)
    .set({ transcribeState: state, updatedAt: Temporal.Now.instant() })
    .where(eq(imageSources.key, key));
}

/** Set the mirror (CDN → R2 copy) state on an image-source row. */
export async function setImageMirrorState(
  db: Database,
  key: string,
  state: PhaseState,
): Promise<void> {
  await db
    .update(imageSources)
    .set({ mirrorState: state, updatedAt: Temporal.Now.instant() })
    .where(eq(imageSources.key, key));
}

/**
 * Record an image source's transcription (get-or-create by key). `textsJa` is
 * every transcribed span ([] if none). Returns the surrogate source id (used as
 * translations.item_id and images.source_id). Whether it's worth localizing is
 * derived from textsJa.
 */
export async function upsertImageTranscription(
  db: Database,
  params: { key: string; textsJa: string[]; model: string },
): Promise<number> {
  const now = Temporal.Now.instant();
  const rows = await db
    .insert(imageSources)
    .values({
      key: params.key,
      textsJa: params.textsJa,
      transcribeModel: params.model,
      transcribeState: 'done',
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: imageSources.key,
      set: {
        textsJa: params.textsJa,
        transcribeModel: params.model,
        transcribeState: 'done',
        updatedAt: now,
      },
    })
    .returning({ id: imageSources.id });
  return rows[0].id;
}

/** One row of an image's restructured Japanese spans. `from` is the index the
 *  row occupied in the CURRENT texts_ja, or null for a newly added row. */
export type ImageSpanEdit = { text: string; from: number | null };

/**
 * Rewrite an image's Japanese spans — the admin edit screen's add/remove/edit
 * of the JA→target rows, which the transcriber otherwise owns.
 *
 * Every language's translated `text` row is index-aligned to `texts_ja`, so the
 * spans can't move on their own: dropping a span anywhere but the tail would
 * shift every later translation onto the wrong source text, in every language
 * at once. Callers therefore say where each surviving row CAME FROM, and this
 * replays that mapping across all of them — the same edit, applied everywhere,
 * in one atomic batch.
 *
 * A row without a `from` starts blank in every language: there is no translated
 * text for source text that didn't exist until now.
 */
export async function restructureImageTexts(
  db: Database,
  imageId: number,
  spans: ImageSpanEdit[],
): Promise<void> {
  const now = Temporal.Now.instant();

  const rows = await db
    .select()
    .from(translations)
    .where(
      and(
        eq(translations.itemType, 'image'),
        eq(translations.itemId, String(imageId)),
        eq(translations.field, 'text'),
      ),
    )
    .all();

  const statements: BatchItem<'sqlite'>[] = [
    db
      .update(imageSources)
      .set({ textsJa: spans.map((s) => s.text), updatedAt: now })
      .where(eq(imageSources.id, imageId)),
  ];

  for (const row of rows) {
    let previous: string[] = [];
    try {
      const parsed = JSON.parse(row.value ?? '[]');
      if (Array.isArray(parsed)) previous = parsed as string[];
    } catch {
      // A malformed value realigns to blanks rather than failing the edit.
    }
    const next = spans.map((s) =>
      s.from === null ? '' : (previous[s.from] ?? ''),
    );
    statements.push(
      db
        .update(translations)
        .set({ value: JSON.stringify(next), updatedAt: now })
        .where(
          and(
            eq(translations.itemType, 'image'),
            eq(translations.itemId, String(imageId)),
            eq(translations.language, row.language),
            eq(translations.field, 'text'),
          ),
        ),
    );
  }

  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

/** Look up image-source rows by their natural keys (imageKey). */
export async function getImageSourcesByKeys(
  db: Database,
  keys: string[],
): Promise<ImageSource[]> {
  return chunked(keys, (slice) =>
    db
      .select()
      .from(imageSources)
      .where(inArray(imageSources.key, slice))
      .all(),
  );
}
