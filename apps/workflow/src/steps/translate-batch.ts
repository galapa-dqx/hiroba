/**
 * Batch translation — the async path for oversized documents.
 *
 * A whole-document translation is a single Gemini call that must regenerate the
 * entire RTML tree in the target language. For large docs (hundreds of blocks)
 * that one synchronous request runs for minutes and times out (524). Instead of
 * chunking — which would lose the whole-document context the echo relies on — we
 * hand the same one-shot requests to Gemini's Batch API, which runs them off the
 * request/response cycle (submit → poll → read inline responses). Turnaround is
 * best-effort (target 24h, usually far less) at half the token cost.
 *
 * The workflow routes here by size (see `bodyMarkupSize`); event titles are
 * small and stay synchronous. Batch input/output rides inline (no file upload —
 * our payload is ~one request per language, well under the 20 MB inline cap),
 * which keeps it Worker-friendly. Request building and response handling are the
 * same `buildBodyContext` / `applyBodyTranslation` the sync path uses.
 */

import { GoogleGenAI } from '@google/genai';

import { setTranslationStates, type Database } from '@hiroba/db';
import { type Block } from '@hiroba/richtext';

import { GEMINI_MODEL } from '../gemini';
import type { ItemType } from '../types';
import {
  applyBodyTranslation,
  buildBodyContext,
  type TargetLanguage,
} from './translate';

/**
 * RTML size (chars) above which a document's body translation is routed to the
 * batch path rather than a synchronous request. ~30 KB is roughly 10K output
 * tokens (~1–1.5 min of generation) — comfortably inside the sync client's
 * 2-minute timeout, with margin. Tune against real latencies.
 */
export const BATCH_TRANSLATE_THRESHOLD_CHARS = 30_000;

/** Poll cadence and horizon for a submitted batch (durable `step.sleep`s). */
export const BATCH_POLL_INTERVAL = '5 minutes';
export const BATCH_MAX_POLLS = 288; // 5 min × 288 ≈ 24 h (the batch SLA ceiling)

/** Batch job states past which the result won't change. */
const TERMINAL_STATES = new Set([
  'JOB_STATE_SUCCEEDED',
  'JOB_STATE_FAILED',
  'JOB_STATE_CANCELLED',
  'JOB_STATE_EXPIRED',
]);

export const isBatchTerminal = (state: string): boolean =>
  TERMINAL_STATES.has(state);

/** What `submitBodyBatch` hands the poll/retrieve steps. */
export type BodyBatchHandle = {
  /** Server-generated batch resource name to poll and read. */
  batchName: string;
  /** Language codes in submission order (a fallback for response correlation). */
  languages: string[];
};

const genai = (apiKey: string) => new GoogleGenAI({ apiKey });

/** Pull the concatenated text out of a batch inline response's candidate. */
export function responseText(
  inline: { response?: unknown } | undefined,
): string {
  const parts =
    (
      inline?.response as
        | {
            candidates?: Array<{
              content?: { parts?: Array<{ text?: string }> };
            }>;
          }
        | undefined
    )?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? '').join('');
}

/**
 * Submit one inline batch request per language for the article body, marking
 * each language's title/content rows `running`. Returns the batch handle to poll
 * — the actual translations land later, in `retrieveBodyBatch`.
 */
export async function submitBodyBatch(
  db: Database,
  apiKey: string,
  itemType: ItemType,
  itemId: string,
  item: { titleJa: string },
  blocks: Block[],
  languages: TargetLanguage[],
): Promise<BodyBatchHandle> {
  const inlinedRequests = [];
  for (const target of languages) {
    await setTranslationStates(db, {
      itemType,
      itemId,
      language: target.code,
      fields: ['title', 'content'],
      state: 'running',
    });
    // buildBodyContext mutates `blocks`' image text in place; we capture the
    // serialized markup string immediately, so the next language's rebuild
    // doesn't disturb this request.
    const ctx = await buildBodyContext(db, item, blocks, target);
    inlinedRequests.push({
      model: GEMINI_MODEL,
      contents: [{ role: 'user', parts: [{ text: ctx.markup }] }],
      config: { systemInstruction: ctx.systemContent, temperature: 0.3 },
      metadata: { language: target.code },
    });
  }

  const job = await genai(apiKey).batches.create({
    model: GEMINI_MODEL,
    src: { inlinedRequests },
    config: { displayName: `translate:${itemType}:${itemId}` },
  });
  if (!job.name) throw new Error('batch create returned no resource name');
  return { batchName: job.name, languages: languages.map((l) => l.code) };
}

/** Current state of a submitted batch (a `JobState` string). */
export async function pollBodyBatch(
  apiKey: string,
  batchName: string,
): Promise<string> {
  const job = await genai(apiKey).batches.get({ name: batchName });
  return job.state ?? 'JOB_STATE_UNSPECIFIED';
}

/**
 * Read a settled batch's inline responses and apply each language's translated
 * body via the shared `applyBodyTranslation`. A language whose response is
 * missing or errored has its rows marked `failed` (settling the snapshot rather
 * than stranding it `running`). Returns the number of fields written.
 *
 * `blocks`/`item` are re-read fresh here (hours after submission) and the
 * per-language context rebuilt deterministically — the same inputs the request
 * was serialized from.
 */
export async function retrieveBodyBatch(
  db: Database,
  apiKey: string,
  itemType: ItemType,
  itemId: string,
  item: { titleJa: string },
  blocks: Block[],
  languages: TargetLanguage[],
  batchName: string,
): Promise<number> {
  const job = await genai(apiKey).batches.get({ name: batchName });
  const responses = job.dest?.inlinedResponses ?? [];
  // Correlate by the metadata language key we set at submit; fall back to
  // position (the API preserves request order).
  const byLanguage = new Map<string, (typeof responses)[number]>();
  responses.forEach((r, i) => {
    const key = r.metadata?.language ?? languages[i]?.code;
    if (key) byLanguage.set(key, r);
  });

  let fields = 0;
  for (const target of languages) {
    const inline = byLanguage.get(target.code);
    const text = inline?.error ? '' : responseText(inline);
    if (!text) {
      await setTranslationStates(db, {
        itemType,
        itemId,
        language: target.code,
        fields: ['title', 'content'],
        state: 'failed',
        error: inline?.error?.message ?? 'batch returned no translation',
      });
      continue;
    }
    const ctx = await buildBodyContext(db, item, blocks, target);
    fields += await applyBodyTranslation(
      db,
      itemType,
      itemId,
      item,
      blocks,
      target,
      ctx,
      text,
    );
  }
  return fields;
}
