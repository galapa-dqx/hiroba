/**
 * Transcribe-images step — reads the text baked into a topic's images (event
 * banners, decorative headings) into the `images` table, keyed by imageKey so the
 * work is deduped across every topic that references the same image.
 *
 * Uses Gemini 3.1 Flash Lite vision with structured output. Stores every span
 * (`texts_ja = []` when an image has no text) so a re-run skips it. Whether an
 * image is worth translating/localizing ("has Japanese") is derived from
 * `texts_ja` later, not here. Bytes come from the R2 mirror (falling back to the
 * CDN), so each image is fetched at most once.
 */

import type OpenAI from 'openai';

import {
  ensureImageSourceRows,
  getImageSourcesByKeys,
  setImageTranscribeState,
  upsertImageTranscription,
  type Database,
} from '@hiroba/db';
import {
  collectImages,
  imageKey,
  imageUpstreamUrl,
  type Block,
} from '@hiroba/richtext';

import { mapWithConcurrency } from '../concurrency';
import { createGemini, GEMINI_MODEL } from '../gemini';

/** Max concurrent Gemini vision calls; kept modest to stay under rate limits. */
const TRANSCRIBE_CONCURRENCY = 6;

const TRANSCRIBE_PROMPT =
  'Transcribe the spans of text in this image verbatim, combining connected strings.';

const TRANSCRIBE_SCHEMA = {
  type: 'object',
  properties: { texts: { type: 'array', items: { type: 'string' } } },
  propertyOrdering: ['texts'],
  required: ['texts'],
} as const;

const IMAGE_FETCH_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Referer: 'https://hiroba.dqx.jp/',
};

/** Encode raw image bytes as a base64 data URL (what the vision API wants). */
function toDataUrl(type: string, buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++)
    binary += String.fromCharCode(bytes[i]);
  return `data:${type};base64,${btoa(binary)}`;
}

/** Load an image by key as a base64 data URL — from the R2 mirror, else the CDN. */
async function loadByKey(
  key: string,
  bucket: R2Bucket,
): Promise<string | null> {
  try {
    const obj = await bucket.get(key);
    if (obj)
      return toDataUrl(
        obj.httpMetadata?.contentType ?? 'image/jpeg',
        await obj.arrayBuffer(),
      );
  } catch {
    // fall through to a direct fetch
  }
  try {
    const res = await fetch(imageUpstreamUrl(key), {
      headers: IMAGE_FETCH_HEADERS,
    });
    if (!res.ok) return null;
    return toDataUrl(
      res.headers.get('content-type') ?? 'image/jpeg',
      await res.arrayBuffer(),
    );
  } catch {
    return null;
  }
}

async function transcribeOne(
  client: OpenAI,
  imageUrl: string,
): Promise<string[]> {
  const response = await client.chat.completions.create({
    model: GEMINI_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: TRANSCRIBE_PROMPT },
          { type: 'image_url', image_url: { url: imageUrl } },
        ],
      },
    ],
    response_format: {
      type: 'json_schema',
      json_schema: { name: 'transcription', schema: TRANSCRIBE_SCHEMA },
    },
  });
  const content = response.choices[0]?.message?.content ?? '{}';
  try {
    const parsed = JSON.parse(content) as { texts?: string[] };
    return (parsed.texts ?? []).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/** How one image's transcription attempt ended: freshly transcribed, skipped
 *  because a previous run already did it, or failed (row marked failed). */
export type TranscribeOutcome = 'transcribed' | 'skipped' | 'failed';

/**
 * Transcribe one image key's baked-in text into the `images` table (the
 * per-unit worker behind `transcribeImages`, exported for the flow framework's
 * per-image `map` units). Skips a key already transcribed. Never throws for a
 * bad image — the row is marked failed and `'failed'` returned, because one
 * bad image degrades the article, never blocks it.
 */
export async function transcribeOneImage(
  db: Database,
  key: string,
  apiKey: string,
  bucket: R2Bucket,
): Promise<TranscribeOutcome> {
  const [existing] = await getImageSourcesByKeys(db, [key]);
  if (existing?.transcribeState === 'done') return 'skipped';
  return (await transcribeKey(db, createGemini(apiKey), bucket, key))
    ? 'transcribed'
    : 'failed';
}

/** Transcribe a single key, no done-check (both entry points share this). */
async function transcribeKey(
  db: Database,
  client: OpenAI,
  bucket: R2Bucket,
  key: string,
): Promise<boolean> {
  await setImageTranscribeState(db, key, 'running');
  try {
    const dataUrl = await loadByKey(key, bucket);
    if (!dataUrl) {
      await setImageTranscribeState(db, key, 'failed');
      return false;
    }
    const spans = await transcribeOne(client, dataUrl);
    await upsertImageTranscription(db, {
      key,
      textsJa: spans,
      model: GEMINI_MODEL,
    });
    return true;
  } catch (err) {
    // One bad image shouldn't wedge the whole step (or strand this row in
    // 'running' — shared rows aren't covered by the workflow's mark-failed).
    console.error(`Failed to transcribe ${key}:`, err);
    await setImageTranscribeState(db, key, 'failed');
    return false;
  }
}

/**
 * Transcribe every not-yet-transcribed image referenced by `blocks` into the
 * `images` table. Returns the count transcribed this run.
 */
export async function transcribeImages(
  db: Database,
  blocks: Block[],
  apiKey: string,
  bucket: R2Bucket,
): Promise<number> {
  const keys = [
    ...new Set(
      collectImages(blocks)
        .map((img) => imageKey(img.src))
        .filter((k): k is string => !!k),
    ),
  ];
  if (keys.length === 0) return 0;

  // Discovery: every referenced image gets a row (pending) so the pipeline
  // snapshot can see the full set before transcription completes.
  await ensureImageSourceRows(db, keys);

  const existing = await getImageSourcesByKeys(db, keys);
  const done = new Set(
    existing.filter((r) => r.transcribeState === 'done').map((r) => r.key),
  );

  const client = createGemini(apiKey);
  let transcribed = 0;
  await mapWithConcurrency(keys, TRANSCRIBE_CONCURRENCY, async (key) => {
    if (done.has(key)) return;
    if (await transcribeKey(db, client, bucket, key)) transcribed++;
  });
  return transcribed;
}
