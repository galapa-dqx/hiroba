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

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

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

/**
 * Localize every text-bearing image referenced by `blocks` into one language.
 * Idempotent per (language, model).
 */
async function localizeImagesForLanguage(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  rows: Awaited<ReturnType<typeof getImagesByKeys>>,
  target: TargetLanguage,
): Promise<LocalizeResult> {
  const language = target.code;
  const ids = rows.map((r) => r.id);
  const translatedText = await getImageTranslations(db, ids, language, 'text');
  const localizedBy = await getLocalizedImageModels(db, ids, language);

  let localized = 0;
  let skipped = 0;
  let failed = 0;

  /** Record a terminal failure on the image's `url` row (and count it). */
  const markFailed = async (imageId: number, error: string) => {
    failed++;
    await setTranslationStates(db, {
      itemType: 'image',
      itemId: String(imageId),
      language,
      fields: ['url'],
      state: 'failed',
      error,
    });
  };

  await mapWithConcurrency(rows, LOCALIZE_CONCURRENCY, async (row) => {
    const isCandidate = !!row.textsJa && hasJapanese(row.textsJa);
    const translatedJson = translatedText.get(row.id);
    if (!translatedJson) {
      // No translated spans. Fine for text-free images — but a Japanese-bearing
      // image here means its translation never landed; fail the url row
      // explicitly so the pipeline snapshot settles instead of waiting forever.
      if (isCandidate) {
        await markFailed(row.id, 'image text was never translated');
      } else {
        skipped++;
      }
      return;
    }
    if (localizedBy.get(row.id) === IMAGE_MODEL) {
      skipped++; // already localized by the current model
      return;
    }

    const translatedSpans = JSON.parse(translatedJson) as string[];
    const jaSpans = row.textsJa ?? [];
    const pairs = jaSpans
      .map((ja, i) => ({ ja, translated: translatedSpans[i] ?? ja }))
      .filter((p) => hasJapanese([p.ja]));
    if (pairs.length === 0) {
      skipped++;
      return;
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
        await markFailed(row.id, 'failed to load original image');
        return;
      }

      // gpt-image-2 only ingests jpeg/png/webp; re-encode anything else (GIF, …).
      const editable = await toEditableImage(images, {
        bytes: original.bytes,
        mimeType: original.mimeType,
      });
      if (!editable) {
        await markFailed(row.id, 'image could not be transcoded for editing');
        return;
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
          await markFailed(row.id, 'image could not be matted for editing');
          return;
        }
        editInput = { bytes: padded, mimeType: 'image/png' };
      }

      const edited = await editImage(apiKey, {
        imageBytes: editInput.bytes,
        mimeType: editInput.mimeType,
        prompt: buildPrompt(target.label, pairs, matted),
      });
      if (!edited) {
        await markFailed(row.id, 'image edit failed');
        return;
      }

      // Recover transparency from the two-up (matted images only), then trim
      // the padding gpt-image-2 adds back to the original's aspect ratio.
      const restored = matted ? recoverAlphaFromTwoUp(edited) : edited;
      if (!restored) {
        await markFailed(row.id, 'two-up alpha recovery failed');
        return;
      }
      const localizedBytes = trimToAspect(restored, original.bytes);

      const localizedKey = `${localizedPrefix(language)}/${row.key}`;
      await bucket.put(localizedKey, localizedBytes, {
        httpMetadata: { contentType: 'image/png', cacheControl: CACHE_CONTROL },
      });
      await upsertImageTranslation(db, {
        imageId: row.id,
        language,
        field: 'url',
        value: localizedKey,
        model: IMAGE_MODEL,
      });
      localized++;
    } catch (err) {
      // One bad image shouldn't wedge the step or strand its row in 'running'
      // (shared rows aren't covered by the workflow's mark-failed).
      console.error(`Failed to localize ${row.key} (${language}):`, err);
      await markFailed(row.id, err instanceof Error ? err.message : 'unknown');
    }
  });

  return { localized, skipped, failed };
}

/**
 * Localize every text-bearing image referenced by `blocks`, once per target
 * language. Idempotent per (language, model).
 */
export async function localizeImages(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  blocks: Block[],
  targetLanguages: TargetLanguage[],
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
    );
    total.localized += result.localized;
    total.skipped += result.skipped;
    total.failed += result.failed;
  }
  return total;
}
