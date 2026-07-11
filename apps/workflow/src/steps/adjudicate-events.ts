/**
 * Event adjudication — the LLM half of event resolution (pass 1.5).
 *
 * The resolver ([@hiroba/db] saveArticleEvents) dedups the easy cases itself:
 * an incoming event whose title matches an existing one, verbatim, *is* that
 * event. What it can't decide with string equality is the residue — an event
 * that shares a time window with existing ones but whose title differs. Those
 * are handed here, in one batch, and this asks Gemini the one question code
 * can't: "is this the same real-world campaign as one of these, or a new one?"
 *
 * The distinction embeddings get backwards: storefront/platform variants of one
 * sale sit at near-identical cosine distance yet are *different* events, while a
 * reworded title of the same campaign must merge. So it's a reasoning call, and
 * the prompt leans hard toward null — a wrong merge silently deletes a real
 * event, a wrong split just leaves a duplicate the nightly reconcile can catch.
 */

import type { Adjudicator, Residual } from '@hiroba/db';

import { createGemini, GEMINI_MODEL, stripCodeFence } from '../gemini';

const ADJUDICATION_PROMPT = `# Event Identity Matching

You are given NEW calendar events and, for each, CANDIDATE existing events that
occur around the same time. For every NEW event decide whether it is the **same
real-world event/campaign** as exactly one candidate, or none.

Return a candidate as the match only when it is genuinely the same occurrence —
the same official campaign (wording may differ) on the same schedule.

Treat as **different** events (do not match — return null unless a *different*
candidate is the true same one):
- Different **storefront/retailer** (Amazon.co.jp, 楽天ブックス, スクウェア・エニックス e-STORE, セブン-イレブン, …) — separate sales, even under one campaign name.
- Different **platform/edition** (Windows / PlayStation®4 / Nintendo Switch™; download vs boxed).
- Different **installment or round** (第一弾 vs 第二弾, 第10回 vs 第11回).
- Merely similar, adjacent, or thematically related events.

When unsure, return null: a wrong merge silently deletes a real event; a missed
merge only leaves a duplicate.

## Input
A JSON array; each item:
{ "id": <number>, "new": { "title", "type", "start", "end" },
  "candidates": [ { "id": "<candidate id>", "title", "type", "start", "end" }, … ] }

## Output
JSON array only — one object per input id, in the same order:
[ { "id": <number>, "same_as": "<candidate id>" | null }, … ]
No prose, no code fence.`;

/** Compact view of one event for the model. */
function brief(
  type: string,
  title: string,
  start: { toString(): string },
  end: { toString(): string } | null,
) {
  return {
    title,
    type,
    start: start.toString(),
    end: end ? end.toString() : null,
  };
}

/** Serialize the batch of residuals into the model's input JSON. */
export function buildAdjudicationInput(residuals: Residual[]): string {
  const payload = residuals.map((r, i) => ({
    id: i,
    new: brief(
      r.event.type,
      r.event.titleJa,
      r.event.startTime,
      r.event.endTime,
    ),
    candidates: r.candidates.map((c) => ({
      id: c.id,
      ...brief(c.type, c.titleJa, c.startTime, c.endTime),
    })),
  }));
  return JSON.stringify(payload, null, 2);
}

/**
 * Parse the model's verdicts back into an array aligned to `residuals`: the
 * matched candidate id, or null. Defensive throughout — a malformed response,
 * or a `same_as` that names something that isn't one of that residual's own
 * candidates, resolves to null (mint a new event) rather than corrupt state.
 */
export function parseAdjudication(
  text: string,
  residuals: Residual[],
): (string | null)[] {
  const out: (string | null)[] = residuals.map(() => null);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    console.warn('Adjudication response was not JSON; treating all as new');
    return out;
  }
  if (!Array.isArray(parsed)) return out;

  const sameAsById = new Map<number, unknown>();
  for (const v of parsed) {
    if (
      v &&
      typeof v === 'object' &&
      typeof (v as { id?: unknown }).id === 'number'
    ) {
      sameAsById.set(
        (v as { id: number }).id,
        (v as { same_as?: unknown }).same_as,
      );
    }
  }
  residuals.forEach((r, i) => {
    const sameAs = sameAsById.get(i);
    if (
      typeof sameAs === 'string' &&
      r.candidates.some((c) => c.id === sameAs)
    ) {
      out[i] = sameAs;
    }
  });
  return out;
}

/**
 * Build an {@link Adjudicator} backed by one batched Gemini call. Injected into
 * saveArticleEvents; on any error it resolves every residual to null (mint new)
 * so extraction never fails on the judge — the reconcile sweep is the net.
 */
export function createEventAdjudicator(apiKey: string): Adjudicator {
  const client = createGemini(apiKey);
  return async (residuals: Residual[]) => {
    if (residuals.length === 0) return [];
    try {
      const response = await client.chat.completions.create({
        model: GEMINI_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: ADJUDICATION_PROMPT },
          { role: 'user', content: buildAdjudicationInput(residuals) },
        ],
      });
      const text = stripCodeFence(
        response.choices[0]?.message?.content ?? '[]',
      );
      return parseAdjudication(text || '[]', residuals);
    } catch (error) {
      console.error('Event adjudication failed; treating all as new:', error);
      return residuals.map(() => null);
    }
  };
}
