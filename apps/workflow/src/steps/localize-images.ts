/**
 * Localize-images step — bake the English translations back into the images.
 *
 * Topics carry text inside banners/headings. The transcribe step read that text
 * (JA spans on `image.text`) and the translate step produced the matching EN
 * spans (the EN block tree's `image.text`, 1:1 by span). Here we hand each image
 * plus its JA→EN pairs to Gemini's image model (Nano Banana Pro) and ask it to
 * swap the Japanese for the provided English in place, then store the result in
 * R2 under `l10n/en/<imageKey>`. The web `/img` route serves that for EN pages
 * and falls back to the original when an image was never localized.
 *
 * Only images that actually have baked-in text are localized (bounds the cost of
 * the image model). Idempotent: skips images already localized in R2.
 */

import { collectImages, imageKey, imageUpstreamUrl, type Block, type ImageNode } from '@hiroba/richtext';

import { generateImageEdit } from '../gemini';

/** R2 key prefix for English-localized images. */
export const LOCALIZED_PREFIX = 'l10n/en';

const FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

const CACHE_CONTROL = 'public, max-age=31536000, immutable';

export type LocalizeResult = {
  /** images newly localized this run */
  localized: number;
  /** already localized (skipped) or no baked-in text */
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

/** Base64-encode raw bytes (chunked to avoid a huge spread on String.fromCharCode). */
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Load the original image bytes — from the R2 mirror if present, else the CDN. */
async function loadOriginal(
  bucket: R2Bucket,
  key: string,
): Promise<{ base64: string; mimeType: string } | null> {
  const obj = await bucket.get(key);
  if (obj) {
    return { base64: toBase64(await obj.arrayBuffer()), mimeType: obj.httpMetadata?.contentType ?? 'image/jpeg' };
  }
  try {
    const res = await fetch(imageUpstreamUrl(key), { headers: FETCH_HEADERS });
    if (!res.ok) return null;
    return { base64: toBase64(await res.arrayBuffer()), mimeType: res.headers.get('content-type') ?? 'image/jpeg' };
  } catch {
    return null;
  }
}

/** Pair an image's JA spans with the EN spans from the translated twin. */
function spanPairs(ja: ImageNode, en: ImageNode | undefined): Array<{ ja: string; en: string }> {
  const enText = en?.text ?? [];
  return (ja.text ?? []).map((j, k) => ({ ja: j, en: enText[k] ?? j }));
}

/**
 * Localize every text-bearing image in a topic. `blocksJa`/`blocksEn` are the
 * same tree in each language, so their images line up by traversal order.
 */
export async function localizeImages(
  bucket: R2Bucket,
  apiKey: string,
  blocksJa: Block[],
  blocksEn: Block[],
): Promise<LocalizeResult> {
  const imagesJa = collectImages(blocksJa);
  const imagesEn = collectImages(blocksEn);

  // If the trees diverged (translation restructured the body) we can't trust the
  // positional pairing — skip rather than burn image-model calls on mismatches.
  if (imagesJa.length !== imagesEn.length) {
    console.warn(`localizeImages: image count mismatch (ja=${imagesJa.length}, en=${imagesEn.length}), skipping`);
    return { localized: 0, skipped: imagesJa.length, failed: 0 };
  }

  let localized = 0;
  let skipped = 0;
  let failed = 0;

  for (let i = 0; i < imagesJa.length; i++) {
    const ja = imagesJa[i];
    if (!ja.text || ja.text.length === 0) {
      skipped++; // no baked-in text to localize
      continue;
    }
    const key = imageKey(ja.src);
    if (!key) {
      skipped++;
      continue;
    }

    const localizedKey = `${LOCALIZED_PREFIX}/${key}`;
    if (await bucket.head(localizedKey)) {
      skipped++; // already localized
      continue;
    }

    const original = await loadOriginal(bucket, key);
    if (!original) {
      failed++;
      continue;
    }

    const edited = await generateImageEdit(apiKey, {
      prompt: buildPrompt(spanPairs(ja, imagesEn[i])),
      imageBase64: original.base64,
      mimeType: original.mimeType,
    });
    if (!edited) {
      failed++;
      continue;
    }

    await bucket.put(localizedKey, fromBase64(edited.data), {
      httpMetadata: { contentType: edited.mimeType, cacheControl: CACHE_CONTROL },
    });
    localized++;
  }

  return { localized, skipped, failed };
}
