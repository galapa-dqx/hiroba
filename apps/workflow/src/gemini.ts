/**
 * Gemini client — Gemini 3.1 Flash Lite, called through Gemini's
 * OpenAI-compatible endpoint so we can reuse the `openai` SDK for chat,
 * JSON-schema structured output, and vision.
 */

import OpenAI from 'openai';

export const GEMINI_MODEL = 'gemini-3.1-flash-lite';
const GEMINI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai/';

export function createGemini(apiKey: string): OpenAI {
  return new OpenAI({
    apiKey,
    baseURL: GEMINI_BASE_URL,
    // Bound every generation. The SDK's default is a 10-minute timeout, so an
    // oversized prompt (e.g. a whole huge document) stalls until Cloudflare's
    // edge returns a 524 (~6½ min) — which the enclosing workflow step then
    // retries, burning tens of minutes before giving up. Fail a hung call fast
    // and cap the SDK's own transient retries; the durable retry that actually
    // matters lives at the workflow-step layer (the flow engine's bounded
    // step defaults, see packages/flow/src/tracker.ts).
    timeout: 120_000, // 2 minutes per request
    maxRetries: 1,
  });
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
