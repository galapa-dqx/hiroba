/**
 * Image localization via OpenAI's image-edit endpoint (gpt-image-2). Isolated so
 * the model/params live in one place. `size: 'auto'` lets the model choose the
 * output shape from the image; the opaque padding it can add (transparent
 * background isn't supported) is trimmed afterwards (see image-trim).
 */

import OpenAI, { toFile } from 'openai';

import { imageDimensions } from './image-trim';

export const IMAGE_MODEL = 'gpt-image-2';

/** Quality tiers gpt-image-2's edit endpoint accepts (`standard` is dall-e-2). */
export const IMAGE_QUALITIES = ['low', 'medium', 'high', 'auto'] as const;
export type ImageQuality = (typeof IMAGE_QUALITIES)[number];

/** Default when a caller doesn't specify — the nightly pipeline's cheap tier. */
const DEFAULT_IMAGE_QUALITY: ImageQuality = 'low';

/**
 * White padding around a matted two-up input: separates the artwork from the
 * canvas edge and gives the model room for the stacked layout (see image-matte).
 */
const PAD_FRACTION = 0.3;
const PAD_MIN = 28;
const PAD_MAX = 128;

/** Input mime types gpt-image-2's edit endpoint accepts. Anything else 400s. */
const EDIT_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Detect the real image type from magic bytes — don't trust upstream headers. */
function sniffMimeType(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length >= 3 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46)
    return 'image/gif'; // "GIF"
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47
  )
    return 'image/png'; // \x89PNG
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return 'image/jpeg';
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 && // "RIFF"
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50 // "WEBP"
  )
    return 'image/webp';
  return null;
}

/**
 * Coerce an image into a format gpt-image-2 can edit (jpeg/png/webp). The DQX CDN
 * also serves GIFs (and the odd other format), which the edit endpoint rejects
 * outright — so we re-encode those to a still PNG via the Cloudflare Images
 * binding (`anim: false` → first frame; gpt-image-2's output is a still anyway).
 * Returns the bytes unchanged when already supported, or null if conversion fails.
 */
export async function toEditableImage(
  images: ImagesBinding,
  input: { bytes: Uint8Array; mimeType: string },
): Promise<{ bytes: Uint8Array; mimeType: string } | null> {
  const actual = sniffMimeType(input.bytes) ?? input.mimeType;
  if (EDIT_INPUT_TYPES.has(actual))
    return { bytes: input.bytes, mimeType: actual };
  try {
    const result = await images
      .input(new Response(input.bytes).body as ReadableStream<Uint8Array>)
      .output({ format: 'image/png', anim: false });
    const png = new Uint8Array(await result.response().arrayBuffer());
    return { bytes: png, mimeType: 'image/png' };
  } catch (err) {
    console.error(`image conversion (${actual} → png) failed:`, err);
    return null;
  }
}

/**
 * Prepare a transparent image for the two-up edit: one Cloudflare Images pass
 * that mattes the transparency onto solid white (`background`) and pads every
 * side with white (`border` — pixels are added, nothing is resized), emitting
 * an opaque PNG. The caller has already established the image is a PNG with
 * meaningful transparency (image-matte's hasMeaningfulTransparency), so this
 * also normalizes shapes fast-png solves poorly (e.g. indexed PNGs with tRNS)
 * into plain truecolor for the edit. Null on failure so the caller can fail
 * the image instead of sending an unmatted input.
 */
export async function matteAndPadForTwoUp(
  images: ImagesBinding,
  bytes: Uint8Array,
): Promise<Uint8Array | null> {
  const dims = imageDimensions(bytes);
  if (!dims) return null;
  const pad = Math.min(
    PAD_MAX,
    Math.max(PAD_MIN, Math.round(dims.height * PAD_FRACTION)),
  );
  try {
    const result = await images
      .input(new Response(bytes).body as ReadableStream<Uint8Array>)
      .transform({
        background: '#FFFFFF',
        border: { color: '#FFFFFF', width: pad },
      })
      .output({ format: 'image/png' });
    return new Uint8Array(await result.response().arrayBuffer());
  } catch (err) {
    console.error('two-up matte/pad transform failed:', err);
    return null;
  }
}

/**
 * Edit an image with gpt-image-2, returning the PNG bytes (or null on failure so
 * the caller leaves the original in place).
 */
export async function editImage(
  apiKey: string,
  input: {
    imageBytes: Uint8Array;
    mimeType: string;
    prompt: string;
    quality?: ImageQuality;
  },
): Promise<Uint8Array | null> {
  // Bound each edit: gpt-image-2 is slow but shouldn't hold a localize
  // concurrency slot for the SDK's 10-minute default when a request stalls.
  const client = new OpenAI({ apiKey, timeout: 180_000, maxRetries: 1 });
  try {
    const file = await toFile(input.imageBytes, 'input', {
      type: input.mimeType,
    });
    const response = await client.images.edit({
      model: IMAGE_MODEL,
      image: file,
      prompt: input.prompt,
      quality: input.quality ?? DEFAULT_IMAGE_QUALITY,
      size: 'auto',
    });
    const b64 = response.data?.[0]?.b64_json;
    return b64 ? base64ToBytes(b64) : null;
  } catch (err) {
    console.error('gpt-image-2 edit failed:', err);
    return null;
  }
}
