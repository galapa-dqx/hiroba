/**
 * Translation-table queries, co-located with the translations schema (DQX-51):
 * the pipeline state machine, the article/title reads, the generic upsert, and
 * the per-image `text` helpers. Everything here reads or writes only the
 * `translations` table.
 */

import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { Temporal } from 'temporal-polyfill';

import type { Block } from '@hiroba/richtext';
import type { PhaseState } from '@hiroba/shared';

import type { Database } from '../client';
import { chunked, IN_CHUNK } from '../d1-limits';
import type { ArticleType } from '../queries';
import {
  translations,
  type ItemType,
  type TranslationField,
} from './translations';

/* ------------------------------------------------------------------ *
 * Pipeline state transitions
 * ------------------------------------------------------------------ */

/**
 * Set the state on translation rows without touching their value — creating
 * the rows if this is the first time a step touches them. A re-run therefore
 * keeps the previous value visible while state says `running`
 * (stale-while-revalidate).
 */
export async function setTranslationStates(
  db: Database,
  params: {
    itemType: ItemType;
    itemId: string;
    language: string;
    fields: TranslationField[];
    state: Exclude<PhaseState, 'done'>; // 'done' only lands with a value, via the upsert helpers
    error?: string;
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  const error = params.state === 'failed' ? (params.error ?? null) : null;
  for (const field of params.fields) {
    await db
      .insert(translations)
      .values({
        itemType: params.itemType,
        itemId: params.itemId,
        language: params.language,
        field,
        state: params.state,
        error,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          translations.itemType,
          translations.itemId,
          translations.language,
          translations.field,
        ],
        set: { state: params.state, error, updatedAt: now },
      });
  }
}

/**
 * Reset any title-translation rows still `running` back to `pending` for a set
 * of items — the title workflow's terminal-failure cleanup, so a chunk that
 * exhausted its retries doesn't leave titles stuck `running`. Deliberately NOT
 * scoped to a language: the failed run's language set is a step return the
 * cleanup can't see, and a whitelist re-read would miss a language disabled
 * mid-run — id-scoped-across-all-languages clears everything the run could
 * have claimed. Only touches `running` rows, so it never clobbers a sibling
 * chunk's `done`.
 */
export async function resetRunningTitles(
  db: Database,
  itemType: ArticleType,
  itemIds: string[],
): Promise<void> {
  if (itemIds.length === 0) return;
  const now = Temporal.Now.instant();
  for (let i = 0; i < itemIds.length; i += IN_CHUNK) {
    await db
      .update(translations)
      .set({ state: 'pending', updatedAt: now })
      .where(
        and(
          eq(translations.itemType, itemType),
          eq(translations.field, 'title'),
          eq(translations.state, 'running'),
          inArray(translations.itemId, itemIds.slice(i, i + IN_CHUNK)),
        ),
      );
  }
}

/**
 * Reset every title-translation row still `running` back to `pending` for one
 * language, across both item types — the backfill workflow's terminal-failure
 * cleanup. Unlike resetRunningTitles it isn't scoped to an id set (the backfill
 * pages the archive rather than carrying ids), so it clears anything a dying
 * run left claimed. Only `running` rows are touched, so a `done` title keeps
 * its value; a title with no value renders its JA fallback either way.
 */
export async function resetRunningTitlesForLanguage(
  db: Database,
  language: string,
): Promise<void> {
  await db
    .update(translations)
    .set({ state: 'pending', updatedAt: Temporal.Now.instant() })
    .where(
      and(
        inArray(translations.itemType, ['news', 'topic', 'playguide']),
        eq(translations.language, language),
        eq(translations.field, 'title'),
        eq(translations.state, 'running'),
      ),
    );
}

/**
 * Terminal cleanup when a workflow dies: this item's translation rows still
 * marked in-flight become `failed`, so the admin panels and later re-runs see
 * a settled state instead of an eternal `running`. Scoped to the item's own
 * rows — shared image rows are owned by whichever workflow is actually
 * touching them.
 */
export async function failPipelineStates(
  db: Database,
  itemType: ArticleType,
  itemId: string,
  language: string,
  error: string,
): Promise<void> {
  const now = Temporal.Now.instant();
  await db
    .update(translations)
    .set({ state: 'failed', error, updatedAt: now })
    .where(
      and(
        eq(translations.itemType, itemType),
        eq(translations.itemId, itemId),
        eq(translations.language, language),
        inArray(translations.state, ['pending', 'running']),
      ),
    );
}

/* ------------------------------------------------------------------ *
 * Reads
 * ------------------------------------------------------------------ */

/**
 * The subset of `itemIds` that already has a `done` translation for
 * (itemType, language, field). Used to skip work — e.g. the "lesser" schedule
 * title translator only fills gaps and must never re-translate/overwrite.
 */
export async function getTranslatedItemIds(
  db: Database,
  itemType: ItemType,
  itemIds: string[],
  language: string,
  field: TranslationField = 'title',
): Promise<Set<string>> {
  const rows = await chunked(itemIds, (slice) =>
    db
      .select({ itemId: translations.itemId })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, itemType),
          eq(translations.language, language),
          eq(translations.field, field),
          eq(translations.state, 'done'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Set(rows.map((r) => r.itemId));
}

/**
 * Get the localized title + block tree for an article (news item or topic), if
 * translated. The `content` translation stores the block tree as a JSON blob.
 * `translatedAt` is the content row's timestamp (falling back to the title's).
 */
export async function getArticleTranslations(
  db: Database,
  itemType: ArticleType,
  id: string,
  language: string = 'en',
): Promise<{
  title: string | null;
  blocks: Block[] | null;
  translatedAt: Temporal.Instant | null;
}> {
  const rows = await db
    .select()
    .from(translations)
    .where(
      and(
        eq(translations.itemType, itemType),
        eq(translations.itemId, id),
        eq(translations.language, language),
      ),
    )
    .all();

  // Stale-while-revalidate: a running re-translation keeps its previous value,
  // which is still the best thing to render. Only value-less rows are skipped.
  let title: string | null = null;
  let blocks: Block[] | null = null;
  let titleAt: Temporal.Instant | null = null;
  let contentAt: Temporal.Instant | null = null;
  for (const row of rows) {
    if (row.value === null) continue;
    if (row.field === 'title') {
      title = row.value;
      titleAt = row.translatedAt;
    } else if (row.field === 'content') {
      try {
        blocks = JSON.parse(row.value) as Block[];
        contentAt = row.translatedAt;
      } catch {
        blocks = null;
      }
    }
  }
  return { title, blocks, translatedAt: contentAt ?? titleAt };
}

/**
 * Map item id → translated title for a set of items. Unlike
 * getArticleTranslations this reads only the title rows — no content blobs —
 * so it stays cheap when called for many items at once.
 */
export async function getTitleTranslations(
  db: Database,
  itemType: ArticleType,
  ids: string[],
  language: string,
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await chunked(ids, (slice) =>
    db
      .select({ itemId: translations.itemId, value: translations.value })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, itemType),
          eq(translations.language, language),
          eq(translations.field, 'title'),
          isNotNull(translations.value),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Map(rows.map((r) => [r.itemId, r.value!]));
}

/* ------------------------------------------------------------------ *
 * Upserts
 * ------------------------------------------------------------------ */

/**
 * Upsert a finished translation row for any non-image item type, landing
 * state='done' with the value and model attribution. Used by the eager title
 * step (DQX-11) so it can write news and topic titles through one helper.
 */
export async function upsertItemTranslation(
  db: Database,
  params: {
    itemType: Exclude<ItemType, 'image'>;
    itemId: string;
    language: string;
    field: TranslationField;
    value: string;
    model: string;
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
      model: params.model,
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
        model: params.model,
        updatedAt: now,
      },
    });
}

/* ------------------------------------------------------------------ *
 * Per-image `text` rows (item_type='image', item_id=image_sources.id)
 * ------------------------------------------------------------------ */

/** The subset of `imageIds` that already have a translated `text` row for `language`. */
export async function getTranslatedImageIds(
  db: Database,
  imageIds: number[],
  language: string,
): Promise<Set<number>> {
  const rows = await chunked(imageIds.map(String), (slice) =>
    db
      .select({ itemId: translations.itemId })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'image'),
          eq(translations.language, language),
          eq(translations.field, 'text'),
          eq(translations.state, 'done'),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Set(rows.map((r) => Number(r.itemId)));
}

/**
 * Map image-source id → its translated `text` spans (the JSON array string) for
 * one language. Only the translated-spans field lives in `translations` now;
 * the localized raster lives on renders (see getServedImages).
 */
export async function getImageTranslations(
  db: Database,
  imageIds: number[],
  language: string,
): Promise<Map<number, string>> {
  const rows = await chunked(imageIds.map(String), (slice) =>
    db
      .select({ itemId: translations.itemId, value: translations.value })
      .from(translations)
      .where(
        and(
          eq(translations.itemType, 'image'),
          eq(translations.language, language),
          eq(translations.field, 'text'),
          isNotNull(translations.value),
          inArray(translations.itemId, slice),
        ),
      )
      .all(),
  );
  return new Map(rows.map((r) => [Number(r.itemId), r.value!]));
}

/**
 * Sentinel `model` for a localized image supplied by hand in the admin (an
 * uploaded raster, or the output of an admin-triggered regeneration the operator
 * has committed to). The localize step treats a row with this model as settled —
 * so the nightly pipeline never silently overwrites a manual override — while an
 * explicit admin "Regenerate" still forces past it (see localizeImages `force`).
 */
export const MANUAL_IMAGE_MODEL = 'manual';

/**
 * Upsert an image source's translated-spans row (item_type='image', field='text',
 * item_id=source id). The localized raster is written as a render, not here.
 */
export async function upsertImageTranslation(
  db: Database,
  params: {
    imageId: number;
    language: string;
    value: string;
    model: string;
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  await db
    .insert(translations)
    .values({
      itemType: 'image',
      itemId: String(params.imageId),
      language: params.language,
      field: 'text',
      state: 'done',
      value: params.value,
      translatedAt: now,
      model: params.model,
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
        model: params.model,
        updatedAt: now,
      },
    });
}
