/**
 * Render queries (images + image_files), co-located with the images schema
 * (DQX-51): one render per (source, language), latest-wins serving,
 * complete-at-birth writes. See schema/images.ts for the model (DQX-45).
 */

import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { Temporal } from 'temporal-polyfill';

import type { Database } from '../client';
import { chunked } from '../d1-limits';
import { imageFiles } from './image-files';
import { imageSources } from './image-sources';
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

/**
 * One render, as ImageFileFlow needs it: its primary file (the bytes every
 * derived file is encoded from) plus the source key + language its embedding
 * pages are purged by. The render's own key isn't reversible to the source's —
 * a versioned l10n key may have had its extension corrected — so the join is
 * how the flow gets from an image id to a purge scope. Null when the id is
 * unknown or (impossibly, given complete-at-birth writes) has no primary.
 */
export type RenderWithSource = {
  id: string;
  language: string | null;
  /** The upstream image's storage key (image_sources.key). */
  sourceKey: string;
  primary: ServedFile;
};

/** Look up one render with its source key and primary file (see the type). */
export async function getRenderWithSource(
  db: Database,
  imageId: string,
): Promise<RenderWithSource | null> {
  const row = await db
    .select({
      id: images.id,
      language: images.language,
      sourceKey: imageSources.key,
      key: imageFiles.key,
      mime: imageFiles.mime,
      width: imageFiles.width,
      height: imageFiles.height,
    })
    .from(images)
    .innerJoin(imageSources, eq(imageSources.id, images.sourceId))
    .innerJoin(
      imageFiles,
      and(eq(imageFiles.imageId, images.id), eq(imageFiles.isPrimary, true)),
    )
    .where(eq(images.id, imageId))
    .limit(1)
    .get();
  if (!row) return null;
  return {
    id: row.id,
    language: row.language,
    sourceKey: row.sourceKey,
    primary: {
      key: row.key,
      mime: row.mime,
      width: row.width,
      height: row.height,
    },
  };
}

/**
 * Replace a render's DERIVED (non-primary) files with `files`, atomically. The
 * primary is never touched: it's the byte-exact raster the render was born
 * with.
 *
 * Replace rather than insert because encode outcomes can differ between passes
 * (a re-run, a repaired backfill) and readers emit every row they find — a
 * stale `<source>` does not fall back on mismatch. Returns the keys that no
 * longer have a row, for the caller to delete from R2 (rows first, objects
 * after: a crash in between leaves orphaned objects, the same benign debris a
 * regeneration leaves, never rows pointing at nothing).
 */
export async function replaceDerivedFiles(
  db: Database,
  imageId: string,
  files: RenderFileInput[],
): Promise<string[]> {
  const existing = await db
    .select({ key: imageFiles.key })
    .from(imageFiles)
    .where(
      and(eq(imageFiles.imageId, imageId), eq(imageFiles.isPrimary, false)),
    )
    .all();

  const fresh = new Set(files.map((f) => f.key));
  const now = Temporal.Now.instant();
  const statements: BatchItem<'sqlite'>[] = [
    // Drop only the rows this pass didn't produce, so surviving keys keep
    // their created_at (and never blink out of existence for a concurrent
    // reader mid-batch).
    db
      .delete(imageFiles)
      .where(
        and(
          eq(imageFiles.imageId, imageId),
          eq(imageFiles.isPrimary, false),
          ...(fresh.size ? [notInArray(imageFiles.key, [...fresh])] : []),
        ),
      ),
    ...files.map((f) =>
      db
        .insert(imageFiles)
        .values({
          key: f.key,
          imageId,
          isPrimary: false,
          mime: f.mime,
          width: f.width,
          height: f.height,
          bytes: f.bytes,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: imageFiles.key,
          set: {
            imageId,
            isPrimary: false,
            mime: f.mime,
            width: f.width,
            height: f.height,
            bytes: f.bytes,
          },
        }),
    ),
  ];
  await db.batch(statements as [BatchItem<'sqlite'>, ...BatchItem<'sqlite'>[]]);

  return existing.map((r) => r.key).filter((key) => !fresh.has(key));
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

/** One stored file of a render — the object key + its measured metadata. */
export type ServedFile = {
  key: string;
  mime: string | null;
  width: number | null;
  height: number | null;
};

/**
 * A render as the web serves it: the byte-exact primary (the `<img src>`
 * fallback and dimension source) plus every derived file recorded beside it
 * (DQX-49's AVIF re-encode and fit renditions), in no particular order.
 * Readers pick from `derived` by mime and dimensions — the rows are the only
 * evidence a derived object exists, since a `<source>` that 404s does NOT
 * fall back to the `<img>`.
 */
export type ServedRender = {
  primary: ServedFile;
  derived: ServedFile[];
};

/** The renders serving a source in one language: the newest localized render
 *  (language match) and the mirrored original (language NULL) fallback. */
export type ServedRenders = {
  localized: ServedRender | null;
  original: ServedRender | null;
};

/**
 * Latest-wins serving for a set of sources in one language. For each source
 * returns the newest localized render (for `language`) and the newest original
 * (the mirrored fallback), each with all of its stored files. Readers serve the
 * localized render on translated pages, else the original, else the raw source.
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
        isPrimary: imageFiles.isPrimary,
        mime: imageFiles.mime,
        width: imageFiles.width,
        height: imageFiles.height,
      })
      .from(images)
      .innerJoin(imageFiles, eq(imageFiles.imageId, images.id))
      .where(
        and(
          inArray(images.sourceId, slice),
          or(eq(images.language, language), isNull(images.language)),
        ),
      )
      .all(),
  );

  // Collect each candidate render's files (one row per file since DQX-49),
  // then keep the newest per (source, localized|original) bucket.
  type Candidate = {
    createdAt: Temporal.Instant;
    id: string;
    sourceId: number;
    bucket: 'l' | 'o';
    primary: ServedFile | null;
    derived: ServedFile[];
  };
  const candidates = new Map<string, Candidate>();
  for (const r of rows) {
    let cand = candidates.get(r.id);
    if (!cand) {
      cand = {
        createdAt: r.createdAt,
        id: r.id,
        sourceId: r.sourceId,
        bucket: r.language === null ? 'o' : 'l',
        primary: null,
        derived: [],
      };
      candidates.set(r.id, cand);
    }
    const file = { key: r.key, mime: r.mime, width: r.width, height: r.height };
    if (r.isPrimary) cand.primary = file;
    else cand.derived.push(file);
  }

  const best = new Map<string, Candidate>();
  for (const cand of candidates.values()) {
    // A render without a primary can't serve an <img> at all — complete-at-
    // birth writes make it impossible, but never let one shadow a usable one.
    if (!cand.primary) continue;
    const mapKey = `${cand.sourceId}:${cand.bucket}`;
    const prev = best.get(mapKey);
    if (!prev || renderIsNewer(cand, prev)) best.set(mapKey, cand);
  }

  const served = (cand: Candidate | undefined): ServedRender | null =>
    cand?.primary ? { primary: cand.primary, derived: cand.derived } : null;
  for (const sourceId of sourceIds) {
    result.set(sourceId, {
      localized: served(best.get(`${sourceId}:l`)),
      original: served(best.get(`${sourceId}:o`)),
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
