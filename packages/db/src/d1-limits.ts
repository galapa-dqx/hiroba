/**
 * D1 statement limits, shared by every query that fans a caller-supplied list
 * into `IN (?, ?, …)`. Public so query helpers that live outside this package
 * (co-located with their single consumer flow, DQX-53) keep the same chunking.
 */

/**
 * D1 caps bound parameters at ~100 per statement, so any query that fans a
 * caller-supplied list into `IN (?, ?, …)` must run in slices. 50 leaves
 * headroom for the query's other parameters.
 */
export const IN_CHUNK = 50;

/** Run `fn` over `items` in IN_CHUNK-sized slices and concatenate the results. */
export async function chunked<T, R>(
  items: T[],
  fn: (slice: T[]) => Promise<R[]>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += IN_CHUNK) {
    out.push(...(await fn(items.slice(i, i + IN_CHUNK))));
  }
  return out;
}
