/**
 * Render queries (images + image_files), co-located with the images schema
 * (DQX-51): one render per (source, language), latest-wins serving,
 * complete-at-birth writes. See schema/images.ts for the model (DQX-45).
 */

import { and, eq, inArray, isNull, or } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Temporal } from 'temporal-polyfill';

import type { Database } from '../client';
import { chunked } from '../d1-limits';
import { imageFiles } from './image-files';
import { images } from './images';

/** Newest-wins comparison for renders: created_at, then id as tiebreak.
 *  Exported for the admin-only render queries in apps/admin/src/lib (DQX-54),
 *  which pick "the newest localized render" the same way. */
export function renderIsNewer(
  a: { createdAt: Temporal.Instant; id: string },
  b: { createdAt: Temporal.Instant; id: string },
): boolean {
  const c = Temporal.Instant.compare(a.createdAt, b.createdAt);
  return c > 0 || (c === 0 && a.id > b.id);
}

/** One stored file of a render — measured at write time (NULLs on seeds). */
export type RenderFileInput = {
  key: string;
  isPrimary: boolean;
  mime: string | null;
  width: number | null;
  height: number | null;
  bytes: number | null;
};

/**
 * Insert one render (an `images` row) plus all its `image_files` in ONE atomic
 * D1 batch — complete-at-birth, so a render either exists with its files or
 * never existed. `id` is client-allocated (crypto.randomUUID()); `language` is
 * NULL for a mirrored original.
 */
export async function insertImageRender(
  db: Database,
  params: {
    id: string;
    sourceId: number;
    language: string | null;
    model: string | null;
    files: RenderFileInput[];
  },
): Promise<void> {
  const now = Temporal.Now.instant();
  const statements: BatchItem<'sqlite'>[] = [
    db.insert(images).values({
      id: params.id,
      sourceId: params.sourceId,
      language: params.language,
      model: params.model,
      createdAt: now,
    }),
    ...params.files.map((f) =>
      db.insert(imageFiles).values({
        key: f.key,
        imageId: params.id,
        isPrimary: f.isPrimary,
        mime: f.mime,
        width: f.width,
        height: f.height,
        bytes: f.bytes,
        createdAt: now,
      }),
    ),
  ];
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);
}

/** Whether a source already has a mirrored-original render (language NULL). One
 *  original per source — mirror creates it once, so re-mirrors don't duplicate
 *  it (its primary file sits at the fixed source key). */
export async function hasOriginalRender(
  db: Database,
  sourceId: number,
): Promise<boolean> {
  const row = await db
    .select({ id: images.id })
    .from(images)
    .where(and(eq(images.sourceId, sourceId), isNull(images.language)))
    .limit(1)
    .get();
  return !!row;
}

/** The served primary file of a render — the object key + measured metadata. */
export type ServedFile = {
  key: string;
  mime: string | null;
  width: number | null;
  height: number | null;
};

/** The renders serving a source in one language: the newest localized render
 *  (language match) and the mirrored original (language NULL) fallback. */
export type ServedRenders = {
  localized: ServedFile | null;
  original: ServedFile | null;
};

/**
 * Latest-wins serving for a set of sources in one language. For each source
 * returns the newest localized render's primary file (for `language`) and the
 * newest original's primary file (the mirrored fallback). Readers serve the
 * localized file on translated pages, else the original, else the raw source.
 */
export async function getServedImages(
  db: Database,
  sourceIds: number[],
  language: string,
): Promise<Map<number, ServedRenders>> {
  const result = new Map<number, ServedRenders>();
  if (sourceIds.length === 0) return result;

  const rows = await chunked(sourceIds, (slice) =>
    db
      .select({
        sourceId: images.sourceId,
        language: images.language,
        createdAt: images.createdAt,
        id: images.id,
        key: imageFiles.key,
        mime: imageFiles.mime,
        width: imageFiles.width,
        height: imageFiles.height,
      })
      .from(images)
      .innerJoin(
        imageFiles,
        and(eq(imageFiles.imageId, images.id), eq(imageFiles.isPrimary, true)),
      )
      .where(
        and(
          inArray(images.sourceId, slice),
          or(eq(images.language, language), isNull(images.language)),
        ),
      )
      .all(),
  );

  // Keep the newest render per (source, localized|original) bucket.
  const best = new Map<
    string,
    { createdAt: Temporal.Instant; id: string; file: ServedFile }
  >();
  for (const r of rows) {
    const mapKey = `${r.sourceId}:${r.language === null ? 'o' : 'l'}`;
    const cand = {
      createdAt: r.createdAt,
      id: r.id,
      file: { key: r.key, mime: r.mime, width: r.width, height: r.height },
    };
    const prev = best.get(mapKey);
    if (!prev || renderIsNewer(cand, prev)) best.set(mapKey, cand);
  }
  for (const sourceId of sourceIds) {
    result.set(sourceId, {
      localized: best.get(`${sourceId}:l`)?.file ?? null,
      original: best.get(`${sourceId}:o`)?.file ?? null,
    });
  }
  return result;
}

/**
 * Model of the newest render per (source, language) — the localize step's skip
 * identity (regenerate only when the newest render's model changed or none
 * exists). Sources without a localized render are absent from the map.
 */
export async function getLatestRenderModels(
  db: Database,
  sourceIds: number[],
  language: string,
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  if (sourceIds.length === 0) return result;

  const rows = await chunked(sourceIds, (slice) =>
    db
      .select({
        sourceId: images.sourceId,
        model: images.model,
        createdAt: images.createdAt,
        id: images.id,
      })
      .from(images)
      .where(
        and(inArray(images.sourceId, slice), eq(images.language, language)),
      )
      .all(),
  );

  const best = new Map<
    number,
    { createdAt: Temporal.Instant; id: string; model: string | null }
  >();
  for (const r of rows) {
    const prev = best.get(r.sourceId);
    if (!prev || renderIsNewer(r, prev)) best.set(r.sourceId, r);
  }
  for (const [sourceId, v] of best) result.set(sourceId, v.model);
  return result;
}
