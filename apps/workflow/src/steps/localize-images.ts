/**
 * Localize-images step — bake the English translations into text-bearing images.
 *
 * Reads each image's source spans (`images.texts_ja`) and their translation
 * (`translations` item_type='image', field='text'), hands the pairs to
 * gpt-image-2, and stores the result in R2 under `l10n/en/<imageKey>`. A
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
import { editImage, IMAGE_MODEL, toEditableImage } from '../image-edit';
import { matteTransparentPng, restoreTransparency } from '../image-matte';
import { trimToAspect } from '../image-trim';

/** R2 key prefix for English-localized images. */
export const LOCALIZED_PREFIX = 'l10n/en';

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

/** Build the localization instruction from the image's JA→EN span pairs. */
function buildPrompt(pairs: Array<{ ja: string; en: string }>): string {
  const mapping = pairs.map((p) => `"${p.ja}" → "${p.en}"`).join('\n');
  return [
    'You are localizing a Japanese image into English. Replace each Japanese text',
    'string in the image with its provided English translation below. Use these',
    'exact translations — do not translate anything yourself, and do not add or',
    'remove text:',
    '',
    mapping,
    '',
    'Reinsert each English translation in place of the matching Japanese text,',
    'matching the original font, size, weight, color, alignment, and effects as',
    'closely as possible. Keep the subject, artwork, background, and layout exactly',
    'the same — no cropping, distortion, or resizing. Leave any text or graphics',
    'not listed above unchanged.',
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
 * Localize every text-bearing image referenced by `blocks`. Idempotent per model.
 */
export async function localizeImages(
  db: Database,
  bucket: R2Bucket,
  images: ImagesBinding,
  apiKey: string,
  blocks: Block[],
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
  const ids = rows.map((r) => r.id);
  const enText = await getImageTranslations(db, ids, 'en', 'text');
  const localizedBy = await getLocalizedImageModels(db, ids, 'en');

  let localized = 0;
  let skipped = 0;
  let failed = 0;

  /** Record a terminal failure on the image's `url` row (and count it). */
  const markFailed = async (imageId: number, error: string) => {
    failed++;
    await setTranslationStates(db, {
      itemType: 'image',
      itemId: String(imageId),
      language: 'en',
      fields: ['url'],
      state: 'failed',
      error,
    });
  };

  await mapWithConcurrency(rows, LOCALIZE_CONCURRENCY, async (row) => {
    const isCandidate = !!row.textsJa && hasJapanese(row.textsJa);
    const enJson = enText.get(row.id);
    if (!enJson) {
      // No EN spans. Fine for text-free images — but a Japanese-bearing image
      // here means its translation never landed; fail the url row explicitly
      // so the pipeline snapshot settles instead of waiting forever.
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

    const enSpans = JSON.parse(enJson) as string[];
    const jaSpans = row.textsJa ?? [];
    const pairs = jaSpans
      .map((ja, i) => ({ ja, en: enSpans[i] ?? ja }))
      .filter((p) => hasJapanese([p.ja]));
    if (pairs.length === 0) {
      skipped++;
      return;
    }

    await setTranslationStates(db, {
      itemType: 'image',
      itemId: String(row.id),
      language: 'en',
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

      // gpt-image-2 can't round-trip transparency; matte onto black first and
      // key it back out after the edit (see image-matte). No-op for opaque images.
      const prepared =
        editable.mimeType === 'image/png'
          ? matteTransparentPng(editable.bytes)
          : { bytes: editable.bytes, matted: false };

      const edited = await editImage(apiKey, {
        imageBytes: prepared.bytes,
        mimeType: editable.mimeType,
        prompt: buildPrompt(pairs),
      });
      if (!edited) {
        await markFailed(row.id, 'image edit failed');
        return;
      }

      // Restore transparency (matted images only), then trim the padding
      // gpt-image-2 adds back to the original's aspect ratio.
      const restored = prepared.matted ? restoreTransparency(edited) : edited;
      const localizedBytes = trimToAspect(restored, original.bytes);

      const localizedKey = `${LOCALIZED_PREFIX}/${row.key}`;
      await bucket.put(localizedKey, localizedBytes, {
        httpMetadata: { contentType: 'image/png', cacheControl: CACHE_CONTROL },
      });
      await upsertImageTranslation(db, {
        imageId: row.id,
        language: 'en',
        field: 'url',
        value: localizedKey,
        model: IMAGE_MODEL,
      });
      localized++;
    } catch (err) {
      // One bad image shouldn't wedge the step or strand its row in 'running'
      // (shared rows aren't covered by the workflow's mark-failed).
      console.error(`Failed to localize ${row.key}:`, err);
      await markFailed(row.id, err instanceof Error ? err.message : 'unknown');
    }
  });

  return { localized, skipped, failed };
}
