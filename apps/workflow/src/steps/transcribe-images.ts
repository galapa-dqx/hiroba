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
  collectImages,
  imageKey,
  imageUpstreamUrl,
  type Block,
} from '@hiroba/richtext';
import { getImagesByKeys, upsertImageTranscription, type Database } from '@hiroba/db';

import { createGemini, GEMINI_MODEL } from '../gemini';

const TRANSCRIBE_PROMPT = 'Transcribe the spans of text in this image verbatim, combining connected strings.';

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
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${type};base64,${btoa(binary)}`;
}

/** Load an image by key as a base64 data URL — from the R2 mirror, else the CDN. */
async function loadByKey(key: string, bucket: R2Bucket): Promise<string | null> {
  try {
    const obj = await bucket.get(key);
    if (obj) return toDataUrl(obj.httpMetadata?.contentType ?? 'image/jpeg', await obj.arrayBuffer());
  } catch {
    // fall through to a direct fetch
  }
  try {
    const res = await fetch(imageUpstreamUrl(key), { headers: IMAGE_FETCH_HEADERS });
    if (!res.ok) return null;
    return toDataUrl(res.headers.get('content-type') ?? 'image/jpeg', await res.arrayBuffer());
  } catch {
    return null;
  }
}

async function transcribeOne(client: OpenAI, imageUrl: string): Promise<string[]> {
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
    ...new Set(collectImages(blocks).map((img) => imageKey(img.src)).filter((k): k is string => !!k)),
  ];
  if (keys.length === 0) return 0;

  const existing = await getImagesByKeys(db, keys);
  const done = new Set(existing.filter((r) => r.textsJa !== null).map((r) => r.key));

  const client = createGemini(apiKey);
  let transcribed = 0;
  for (const key of keys) {
    if (done.has(key)) continue;
    const dataUrl = await loadByKey(key, bucket);
    if (!dataUrl) continue;
    const spans = await transcribeOne(client, dataUrl);
    await upsertImageTranscription(db, { key, textsJa: spans, model: GEMINI_MODEL });
    transcribed++;
  }
  return transcribed;
}
