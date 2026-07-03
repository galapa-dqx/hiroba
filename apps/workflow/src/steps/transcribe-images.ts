/**
 * Transcribe-images step — reads text baked into a topic's images (event banners,
 * decorative headings) so it can be translated in-context with the body.
 *
 * Uses Gemini 3.1 Flash Lite vision with structured output. The transcribed spans
 * are joined onto `ImageNode.text`, which serializes into the translation markup
 * as `<figure>…</figure>` (see @hiroba/richtext) so it rides the same translation
 * call. Mutates the block tree in place and returns the number of images updated;
 * the caller persists the updated `blocks_ja`.
 */

import type OpenAI from 'openai';

import { imageKey, isBlock, type Block, type ImageNode, type Inline } from '@hiroba/richtext';

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

/** Collect every block-level image in the tree (returns mutable references). */
export function collectImages(blocks: Block[]): ImageNode[] {
  const out: ImageNode[] = [];

  const visitContent = (n: Block | Inline) => {
    if (isBlock(n)) visitBlock(n);
  };

  const visitBlock = (node: Block) => {
    switch (node.type) {
      case 'image':
        out.push(node);
        break;
      case 'infoBox':
      case 'section':
      case 'accordion':
      case 'speechBubble':
      case 'messageBox':
        node.children.forEach(visitContent);
        break;
      case 'list':
        node.items.forEach((it) => it.children.forEach(visitContent));
        break;
      case 'table':
        node.headers?.forEach((c) => c.children.forEach(visitContent));
        node.rows.forEach((row) => row.forEach((c) => c.children.forEach(visitContent)));
        break;
      case 'interview':
        node.exchanges.forEach((e) => e.answer.forEach(visitBlock));
        break;
      case 'steps':
        node.items.forEach((s) => s.children.forEach(visitBlock));
        break;
      default:
        break; // paragraph/heading/button/divider/video/embed/ranking hold no block images
    }
  };

  blocks.forEach(visitBlock);
  return out;
}

/** Encode raw image bytes as a base64 data URL (what the vision API wants). */
function toDataUrl(type: string, buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return `data:${type};base64,${btoa(binary)}`;
}

/**
 * Load an image as a base64 data URL. Prefers the R2 mirror (the mirror-images
 * step runs first), so we don't re-hit the CDN; falls back to a direct fetch
 * (browser UA/Referer) for anything not mirrored.
 */
async function loadAsDataUrl(src: string, bucket?: R2Bucket): Promise<string | null> {
  const key = bucket ? imageKey(src) : null;
  if (bucket && key) {
    try {
      const obj = await bucket.get(key);
      if (obj) {
        return toDataUrl(obj.httpMetadata?.contentType ?? 'image/jpeg', await obj.arrayBuffer());
      }
    } catch {
      // fall through to a direct fetch
    }
  }

  try {
    const res = await fetch(src, { headers: IMAGE_FETCH_HEADERS });
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
 * Transcribe every not-yet-transcribed image in `blocks`, setting `image.text`
 * (one entry per span). Returns the count of images updated. Reads image bytes
 * from `bucket` (the R2 mirror) when provided, else fetches the CDN directly.
 */
export async function transcribeImages(
  blocks: Block[],
  apiKey: string,
  bucket?: R2Bucket,
): Promise<number> {
  const client = createGemini(apiKey);
  const images = collectImages(blocks).filter((img) => img.text === undefined);
  let updated = 0;
  for (const img of images) {
    const dataUrl = await loadAsDataUrl(img.src, bucket);
    if (!dataUrl) continue;
    const spans = await transcribeOne(client, dataUrl);
    if (spans.length) {
      img.text = spans;
      updated++;
    }
  }
  return updated;
}
