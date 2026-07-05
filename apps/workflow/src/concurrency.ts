/**
 * Bounded-concurrency map — run `fn` over `items` with at most `limit` tasks in
 * flight at once. Used by the per-image pipeline steps (mirror/transcribe/
 * localize) to overlap their per-image work without firing every request at
 * once: LLM calls have rate limits, and even the network-bound mirror shouldn't
 * burst dozens of CDN fetches simultaneously.
 *
 * Order is not preserved. Callers accumulate results via side effects (e.g.
 * counters) inside `fn`, which is safe — the event loop is single-threaded, so
 * interleaved tasks never race on shared state.
 */
export async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    }),
  );
}
