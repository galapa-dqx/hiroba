/**
 * Localize-images step — bake the translated text into text-bearing images,
 * once per enabled target language.
 *
 * Reads each image's source spans (`images.texts_ja`) and their translation
 * (`translations` item_type='image', field='text'), hands the pairs to
 * gpt-image-2, and stores the result in R2 under `l10n/<lang>/<imageKey>`. A
 * `translations` `url` row records the R2 key + the image model, so we skip
 * images already localized by the current model and regenerate when it changes.
 *
 * Only images that were translated (i.e. had Japanese) are candidates.
 */

import {
  getImagesByKeys,
  getImageTranslations,
  getLocalizedImageModels,
  MANUAL_IMAGE_MODEL,
  setTranslationStates,
  upsertImageTranslation,
  type Database,
} from '@hiroba/db';
import {
  collectImages,
  imageKey,
  imageUpstreamUrl,
  type Block,
} from '@hiroba/richtext';
import { hasJapanese } from '@hiroba/shared';

import { mapWithConcurrency } from '../concurrency';
import {
  editImage,
  IMAGE_MODEL,
  matteAndPadForTwoUp,
  toEditableImage,
} from '../image-edit';
import {
  hasMeaningfulTransparency,
  recoverAlphaFromTwoUp,
  TWO_UP_PROMPT,
} from '../image-matte';
import { trimToAspect } from '../image-trim';
import type { TargetLanguage } from './translate';

/** R2 key prefix for a language's localized images. */
export const localizedPrefix = (language: string): string => `l10n/${language}`;

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

// Localized rasters live at a STABLE key (`l10n/<lang>/<imageKey>`) and are
// regenerated in place — on an image-model change, or an admin edit/upload — so
// they can't be `immutable` like the content-keyed originals (mirror-images),
// or a stale copy would stick for a year. A few hours keeps them self-correcting
// if an edge purge is ever missed; a regeneration purges the exact URL for an
// immediate refresh (see purgeImage in workflow-manager's regenerate handler).
const CACHE_CONTROL = 'public, max-age=21600'; // 6 hours

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
type ImageRow = Awaited<ReturnType<typeof getImagesByKeys>>[number];

/** One image's fate through `localizeRowForLanguage` — the unit of LocalizeResult. */
type LocalizeOutcome = 'localized' | 'skipped' | 'failed';

/**
 * Localize one image row into one language — the core both entry points share
 * (`localizeImages` prefetches the per-language maps; `localizeOneImage`
 * fetches per row). Never throws for a bad image — the url row is marked
 * failed and the outcome says so, because one bad image degrades the article,
 * never blocks it.
 */
async function localizeRowForLanguage(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  row: ImageRow,
  target: TargetLanguage,
  /** The row's `text` translation and prior localized-by model, prefetched. */
  seen: {
    translatedJson: string | undefined;
    localizedModel: string | undefined;
  },
  force: boolean,
  /** The model to stamp on the produced `url` row (its later skip identity). */
  model: string,
): Promise<LocalizeOutcome> {
  const language = target.code;

  /** Record a terminal failure on the image's `url` row. */
  const markFailed = async (error: string): Promise<LocalizeOutcome> => {
    await setTranslationStates(db, {
      itemType: 'image',
      itemId: String(row.id),
      language,
      fields: ['url'],
      state: 'failed',
      error,
    });
    return 'failed';
  };

  const isCandidate = !!row.textsJa && hasJapanese(row.textsJa);
  if (!seen.translatedJson) {
    // No translated spans. Fine for text-free images — but a Japanese-bearing
    // image here means its translation never landed; fail the url row
    // explicitly so the pipeline snapshot settles instead of waiting forever.
    if (isCandidate) {
      return markFailed('image text was never translated');
    }
    return 'skipped';
  }
  // Skip images already settled for this language — either localized by the
  // current model, or carrying a hand-supplied manual override. An explicit
  // admin regeneration passes `force` to redo them anyway.
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

  await setTranslationStates(db, {
    itemType: 'image',
    itemId: String(row.id),
    language,
    fields: ['url'],
    state: 'running',
  });

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

    const localizedKey = `${localizedPrefix(language)}/${row.key}`;
    await bucket.put(localizedKey, localizedBytes, {
      httpMetadata: { contentType: 'image/png', cacheControl: CACHE_CONTROL },
    });
    await upsertImageTranslation(db, {
      imageId: row.id,
      language,
      field: 'url',
      value: localizedKey,
      model,
    });
    return 'localized';
  } catch (err) {
    // One bad image shouldn't wedge the step or strand its row in 'running'
    // (shared rows aren't covered by the workflow's mark-failed).
    console.error(`Failed to localize ${row.key} (${language}):`, err);
    return markFailed(err instanceof Error ? err.message : 'unknown');
  }
}

/**
 * Localize one image row into every target language (the per-unit worker
 * behind the flow framework's per-image `map` units — the batch entry point
 * below prefetches per-language maps instead). Idempotent per
 * (language, model), like the batch path.
 */
export async function localizeOneImage(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  row: ImageRow,
  targetLanguages: TargetLanguage[],
): Promise<LocalizeResult> {
  const result: LocalizeResult = { localized: 0, skipped: 0, failed: 0 };
  for (const target of targetLanguages) {
    const translated = await getImageTranslations(
      db,
      [row.id],
      target.code,
      'text',
    );
    const localizedBy = await getLocalizedImageModels(
      db,
      [row.id],
      target.code,
    );
    const outcome = await localizeRowForLanguage(
      db,
      bucket,
      images,
      apiKey,
      row,
      target,
      {
        translatedJson: translated.get(row.id),
        localizedModel: localizedBy.get(row.id),
      },
      false,
      IMAGE_MODEL,
    );
    result[outcome]++;
  }
  return result;
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
): Promise<LocalizeResult> {
  const language = target.code;
  const ids = rows.map((r) => r.id);
  const translatedText = await getImageTranslations(db, ids, language, 'text');
  const localizedBy = await getLocalizedImageModels(db, ids, language);

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
        localizedModel: localizedBy.get(row.id),
      },
      force,
      model,
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
  opts: { force?: boolean; model?: string } = {},
): Promise<LocalizeResult> {
  const keys = [
    ...new Set(
      collectImages(blocks)
        .map((i) => imageKey(i.src))
        .filter((k): k is string => !!k),
    ),
  ];
  if (keys.length === 0) return { localized: 0, skipped: 0, failed: 0 };

  const rows = await getImagesByKeys(db, keys);

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
    );
    total.localized += result.localized;
    total.skipped += result.skipped;
    total.failed += result.failed;
  }
  return total;
}
