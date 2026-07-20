/**
 * Localize-images step — bake the translated text into text-bearing images,
 * once per enabled target language.
 *
 * Reads each source's spans (`image_sources.texts_ja`) and their translation
 * (`translations` item_type='image', field='text'), hands the pairs to
 * gpt-image-2, and stores the result in R2 under a fresh versioned key
 * (`l10n/<lang>/v<ts36>/<imageKey>` — see localizedImageKey in @hiroba/shared).
 * The render is recorded as an `images` row + primary `image_files` (dims
 * measured) in one atomic batch; latest-wins serving means the new render
 * supersedes any prior one. The skip identity is the newest render's `model`:
 * a source already localized by the current model (or a manual override) is
 * skipped, and a model change (or an explicit admin regenerate) redoes it.
 *
 * Only images that were translated (i.e. had Japanese) are candidates.
 */

import {
  getImageSourcesByKeys,
  getImageTranslations,
  getLatestRenderModels,
  insertImageRender,
  MANUAL_IMAGE_MODEL,
  type Database,
} from '@hiroba/db';
import {
  collectImages,
  imageKey,
  imageUpstreamUrl,
  type Block,
} from '@hiroba/richtext';
import {
  hasJapanese,
  LOCALIZED_IMAGE_CACHE_CONTROL,
  localizedImageKey,
  measureImage,
} from '@hiroba/shared';

import { mapWithConcurrency } from '../concurrency';
import {
  editImage,
  IMAGE_MODEL,
  matteAndPadForTwoUp,
  toEditableImage,
  type ImageQuality,
} from '../image-edit';
import {
  hasMeaningfulTransparency,
  recoverAlphaFromTwoUp,
  TWO_UP_PROMPT,
} from '../image-matte';
import { trimToAspect } from '../image-trim';
import type { TargetLanguage } from './translate';

/** A fresh version tag for one localized render (epoch-ms, base36). */
const newVersion = (): string => Date.now().toString(36);

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

// Every render gets a fresh versioned key (never overwritten in place), so
// localized rasters are immutable — see the constant's doc in @hiroba/shared.
// A manual regeneration additionally purges the pages embedding the image
// (see purgeImagePages in the regenerate-image route).
const CACHE_CONTROL = LOCALIZED_IMAGE_CACHE_CONTROL;

/** Max concurrent gpt-image-2 edits; kept modest to stay under rate limits. */
const LOCALIZE_CONCURRENCY = 6;

export type LocalizeResult = {
  /** images newly localized this run */
  localized: number;
  /** already localized by the current model, or nothing to translate */
  skipped: number;
  /** load or generation failed */
  failed: number;
};

/**
 * Build the localization instruction from the image's JA→target span pairs.
 * For a matted (formerly-transparent) image the closing shifts from "keep
 * everything identical" to the two-up arrangement that differential matting
 * solves on.
 */
function buildPrompt(
  language: string,
  pairs: Array<{ ja: string; translated: string }>,
  twoUp: boolean,
): string {
  const mapping = pairs.map((p) => `"${p.ja}" → "${p.translated}"`).join('\n');
  return [
    `You are localizing a Japanese image into ${language}. Replace each Japanese text`,
    `string in the image with its provided ${language} translation below. Use these`,
    'exact translations — do not translate anything yourself, and do not add or',
    'remove text:',
    '',
    mapping,
    '',
    `Reinsert each ${language} translation in place of the matching Japanese text,`,
    'matching the original font, size, weight, color, alignment, and effects as',
    'closely as possible.',
    ...(twoUp
      ? [
          'Keep the subject, artwork, and layout exactly the same.',
          '',
          TWO_UP_PROMPT,
        ]
      : [
          'Keep the subject, artwork, background, and layout exactly',
          'the same — no cropping, distortion, or resizing. Leave any text or graphics',
          'not listed above unchanged.',
        ]),
  ].join('\n');
}

/** Load the original image bytes — from the R2 mirror if present, else the CDN. */
async function loadOriginal(
  bucket: R2Bucket,
  key: string,
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const obj = await bucket.get(key);
  if (obj) {
    return {
      bytes: new Uint8Array(await obj.arrayBuffer()),
      mimeType: obj.httpMetadata?.contentType ?? 'image/jpeg',
    };
  }
  try {
    const res = await fetch(imageUpstreamUrl(key), { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      mimeType: res.headers.get('content-type') ?? 'image/jpeg',
    };
  } catch {
    return null;
  }
}

/** One image row from the shared `images` table. */
type ImageRow = Awaited<ReturnType<typeof getImageSourcesByKeys>>[number];

/**
 * The slice of an image row localization actually reads. Flow map units
 * round-trip through the engine's step storage, which can't serialize the
 * full row's Temporal.Instant `updatedAt` — so the pipeline passes only this.
 */
export type LocalizableImage = Pick<ImageRow, 'id' | 'key' | 'textsJa'>;

/** One image's fate through `localizeRowForLanguage` — the unit of LocalizeResult. */
export type LocalizeOutcome = 'localized' | 'skipped' | 'failed';

/**
 * Localize one image row into one language — the core both entry points share
 * (`localizeImages` prefetches the per-language maps; `localizeImageLanguage`
 * fetches per row). Never throws for a bad image — a failure just returns the
 * `failed` outcome (Flow records it), because one bad image degrades the
 * article, never blocks it.
 */
async function localizeRowForLanguage(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  row: LocalizableImage,
  target: TargetLanguage,
  /** The row's `text` translation and newest render's model, prefetched. */
  seen: {
    translatedJson: string | undefined;
    localizedModel: string | undefined;
  },
  force: boolean,
  /** The model to stamp on the produced render (its later skip identity). */
  model: string,
  /** gpt-image-2 quality tier; undefined uses the generator's cheap default. */
  quality: ImageQuality | undefined,
): Promise<LocalizeOutcome> {
  const language = target.code;

  /** Log + report a terminal failure. There's no `url` row to mark: the render
   *  is written complete-at-birth on success, so a failure is simply no render
   *  this run (the flow unit's `failed` outcome is what settles the snapshot). */
  const markFailed = (error: string): LocalizeOutcome => {
    console.warn(`localize ${row.key} (${language}) failed: ${error}`);
    return 'failed';
  };

  const isCandidate = !!row.textsJa && hasJapanese(row.textsJa);
  if (!seen.translatedJson) {
    // No translated spans. Fine for text-free images — but a Japanese-bearing
    // image here means its translation never landed; report failed so the
    // pipeline snapshot settles instead of waiting forever.
    if (isCandidate) {
      return markFailed('image text was never translated');
    }
    return 'skipped';
  }
  // Skip sources already settled for this language — either the newest render
  // is by the current model, or it's a hand-supplied manual override. An
  // explicit admin regeneration passes `force` to redo them anyway.
  if (
    !force &&
    (seen.localizedModel === IMAGE_MODEL ||
      seen.localizedModel === MANUAL_IMAGE_MODEL)
  ) {
    return 'skipped';
  }

  const translatedSpans = JSON.parse(seen.translatedJson) as string[];
  const jaSpans = row.textsJa ?? [];
  const pairs = jaSpans
    .map((ja, i) => ({ ja, translated: translatedSpans[i] ?? ja }))
    .filter((p) => hasJapanese([p.ja]));
  if (pairs.length === 0) {
    return 'skipped';
  }

  try {
    const original = await loadOriginal(bucket, row.key);
    if (!original) {
      return markFailed('failed to load original image');
    }

    // gpt-image-2 only ingests jpeg/png/webp; re-encode anything else (GIF, …).
    const editable = await toEditableImage(images, {
      bytes: original.bytes,
      mimeType: original.mimeType,
    });
    if (!editable) {
      return markFailed('image could not be transcoded for editing');
    }

    // gpt-image-2 can't round-trip transparency; matte onto white + pad via
    // the Images binding and ask for a stacked black/white two-up, then solve
    // for alpha differentially (see image-matte). Opaque images stay on the
    // plain edit path untouched.
    const matted =
      editable.mimeType === 'image/png' &&
      hasMeaningfulTransparency(editable.bytes);
    let editInput = editable;
    if (matted) {
      const padded = await matteAndPadForTwoUp(images, editable.bytes);
      if (!padded) {
        return markFailed('image could not be matted for editing');
      }
      editInput = { bytes: padded, mimeType: 'image/png' };
    }

    const edited = await editImage(apiKey, {
      imageBytes: editInput.bytes,
      mimeType: editInput.mimeType,
      prompt: buildPrompt(target.label, pairs, matted),
      quality,
    });
    if (!edited) {
      return markFailed('image edit failed');
    }

    // Recover transparency from the two-up (matted images only), then trim
    // the padding gpt-image-2 adds back to the source's geometry — `editable`
    // rather than `original` so a transcoded source (GIF → PNG) still exposes
    // its alpha to the trimmer; the dimensions are the same either way.
    const restored = matted ? recoverAlphaFromTwoUp(edited) : edited;
    if (!restored) {
      return markFailed('two-up alpha recovery failed');
    }
    const localizedBytes = trimToAspect(restored, editable.bytes);

    // gpt-image-2 always emits PNG; correct the key's inherited extension to
    // match the stored bytes (the versioned prefix keeps it collision-free).
    const contentType = 'image/png';
    const localizedKey = localizedImageKey(
      language,
      newVersion(),
      row.key,
      contentType,
    );
    await bucket.put(localizedKey, localizedBytes, {
      httpMetadata: { contentType, cacheControl: CACHE_CONTROL },
    });
    // Record the render + its primary file (dims measured) in one atomic batch.
    const measured = await measureImage(images, localizedBytes);
    await insertImageRender(db, {
      id: crypto.randomUUID(),
      sourceId: row.id,
      language,
      model,
      files: [
        {
          key: localizedKey,
          isPrimary: true,
          mime: measured.mime ?? contentType,
          width: measured.width,
          height: measured.height,
          bytes: localizedBytes.byteLength,
        },
      ],
    });
    return 'localized';
  } catch (err) {
    // One bad image shouldn't wedge the step; report failed and move on.
    console.error(`Failed to localize ${row.key} (${language}):`, err);
    return markFailed(err instanceof Error ? err.message : 'unknown');
  }
}

/**
 * Localize one image row into ONE target language (the ImageLocalizeFlow
 * child's `generate` body — the batch entry point below prefetches
 * per-language maps for many rows instead). Idempotent per (language, model),
 * like the batch path, and never throws for a bad image — the outcome says so.
 */
export async function localizeImageLanguage(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  row: LocalizableImage,
  target: TargetLanguage,
): Promise<LocalizeOutcome> {
  const translated = await getImageTranslations(db, [row.id], target.code);
  const localizedBy = await getLatestRenderModels(db, [row.id], target.code);
  return localizeRowForLanguage(
    db,
    bucket,
    images,
    apiKey,
    row,
    target,
    {
      translatedJson: translated.get(row.id),
      localizedModel: localizedBy.get(row.id) ?? undefined,
    },
    false,
    IMAGE_MODEL,
    undefined,
  );
}

/**
 * Localize every text-bearing image referenced by `blocks` into one language.
 * Idempotent per (language, model).
 */
async function localizeImagesForLanguage(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  rows: ImageRow[],
  target: TargetLanguage,
  force: boolean,
  /** The model to stamp on the produced `url` row (its later skip identity). */
  model: string,
  /** gpt-image-2 quality tier; undefined uses the generator's cheap default. */
  quality: ImageQuality | undefined,
): Promise<LocalizeResult> {
  const language = target.code;
  const ids = rows.map((r) => r.id);
  const translatedText = await getImageTranslations(db, ids, language);
  const localizedBy = await getLatestRenderModels(db, ids, language);

  const result: LocalizeResult = { localized: 0, skipped: 0, failed: 0 };
  await mapWithConcurrency(rows, LOCALIZE_CONCURRENCY, async (row) => {
    const outcome = await localizeRowForLanguage(
      db,
      bucket,
      images,
      apiKey,
      row,
      target,
      {
        translatedJson: translatedText.get(row.id),
        localizedModel: localizedBy.get(row.id) ?? undefined,
      },
      force,
      model,
      quality,
    );
    result[outcome]++;
  });
  return result;
}

/**
 * Localize every text-bearing image referenced by `blocks`, once per target
 * language. Idempotent per (language, model) — pass `force` to regenerate images
 * already localized (or manually overridden), e.g. an admin-triggered redo, and
 * `model` to override the identity stamped on the result (an admin regeneration
 * stamps MANUAL_IMAGE_MODEL so it, like an upload, survives the nightly refresh).
 */
export async function localizeImages(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  blocks: Block[],
  targetLanguages: TargetLanguage[],
  opts: { force?: boolean; model?: string; quality?: ImageQuality } = {},
): Promise<LocalizeResult> {
  const keys = [
    ...new Set(
      collectImages(blocks)
        .map((i) => imageKey(i.src))
        .filter((k): k is string => !!k),
    ),
  ];
  if (keys.length === 0) return { localized: 0, skipped: 0, failed: 0 };

  const rows = await getImageSourcesByKeys(db, keys);

  const total: LocalizeResult = { localized: 0, skipped: 0, failed: 0 };
  for (const target of targetLanguages) {
    const result = await localizeImagesForLanguage(
      db,
      bucket,
      images,
      apiKey,
      rows,
      target,
      opts.force ?? false,
      opts.model ?? IMAGE_MODEL,
      opts.quality,
    );
    total.localized += result.localized;
    total.skipped += result.skipped;
    total.failed += result.failed;
  }
  return total;
}
