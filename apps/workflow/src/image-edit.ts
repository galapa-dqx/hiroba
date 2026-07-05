/**
 * Image localization via OpenAI's image-edit endpoint (gpt-image-2). Isolated so
 * the model/params live in one place. `size: 'auto'` lets the model choose the
 * output shape from the image; the opaque padding it can add (transparent
 * background isn't supported) is trimmed afterwards (see image-trim).
 */

import OpenAI, { toFile } from 'openai';

export const IMAGE_MODEL = 'gpt-image-2';

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Edit an image with gpt-image-2, returning the PNG bytes (or null on failure so
 * the caller leaves the original in place).
 */
export async function editImage(
  apiKey: string,
  input: { imageBytes: Uint8Array; mimeType: string; prompt: string },
): Promise<Uint8Array | null> {
  const client = new OpenAI({ apiKey });
  try {
    const file = await toFile(input.imageBytes, 'input', {
      type: input.mimeType,
    });
    const response = await client.images.edit({
      model: IMAGE_MODEL,
      image: file,
      prompt: input.prompt,
      quality: 'low',
      size: 'auto',
    });
    const b64 = response.data?.[0]?.b64_json;
    return b64 ? base64ToBytes(b64) : null;
  } catch (err) {
    console.error('gpt-image-2 edit failed:', err);
    return null;
  }
}
