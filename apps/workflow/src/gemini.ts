/**
 * Gemini client — Gemini 3.1 Flash Lite, called through Gemini's
 * OpenAI-compatible endpoint so we can reuse the `openai` SDK for chat,
 * JSON-schema structured output, and vision.
 */

import OpenAI from 'openai';

export const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai/';

/**
 * Image model (Nano Banana Pro) for on-image text localization. Some providers
 * expose it as `gemini-3-pro-image-preview`; adjust here if the call 404s.
 */
export const GEMINI_IMAGE_MODEL = 'gemini-3-pro-image';
const GEMINI_NATIVE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

export function createGemini(apiKey: string): OpenAI {
  return new OpenAI({ apiKey, baseURL: GEMINI_BASE_URL });
}

type GeminiPart = { inlineData?: { data?: string; mimeType?: string } };
type GeminiGenerateResponse = { candidates?: Array<{ content?: { parts?: GeminiPart[] } }> };

/** An edited image returned by {@link generateImageEdit}: base64 data + mime. */
export type GeneratedImage = { data: string; mimeType: string };

/**
 * Edit an image with Gemini's image model (image in → image out). Uses the
 * native `generateContent` REST endpoint — image editing isn't available on the
 * OpenAI-compatible chat path {@link createGemini} uses. Isolated here so the
 * (evolving) image-API wire format lives in one place. Returns null on any
 * failure so the caller can leave the original image in place.
 */
export async function generateImageEdit(
  apiKey: string,
  input: { prompt: string; imageBase64: string; mimeType: string },
): Promise<GeneratedImage | null> {
  try {
    const res = await fetch(`${GEMINI_NATIVE_BASE_URL}/models/${GEMINI_IMAGE_MODEL}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: input.prompt }, { inlineData: { mimeType: input.mimeType, data: input.imageBase64 } }],
          },
        ],
        generationConfig: { responseModalities: ['IMAGE'] },
      }),
    });

    if (!res.ok) {
      console.error(`Gemini image edit failed: ${res.status} ${await res.text().catch(() => '')}`);
      return null;
    }

    const json = (await res.json()) as GeminiGenerateResponse;
    for (const part of json.candidates?.[0]?.content?.parts ?? []) {
      if (part.inlineData?.data) {
        return { data: part.inlineData.data, mimeType: part.inlineData.mimeType ?? 'image/png' };
      }
    }
    return null;
  } catch (err) {
    console.error('Gemini image edit error:', err);
    return null;
  }
}

/** Strip a leading/trailing ```-fence the model may wrap its output in. */
export function stripCodeFence(text: string): string {
  let t = text.trim();
  if (t.startsWith('```')) {
    const lines = t.split('\n');
    lines.shift(); // opening ``` (possibly ```html)
    if (lines[lines.length - 1]?.trim() === '```') lines.pop();
    t = lines.join('\n').trim();
  }
  return t;
}
