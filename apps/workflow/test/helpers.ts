/**
 * Shared pool-workers test helpers. Every hub-backed flow suite opens the
 * same well-known hub instance and polls the same way — one home for both,
 * instead of a fresh copy per port.
 */

import { env } from 'cloudflare:test';

import { getFlowHub } from '@hiroba/flow/hub';

/** The well-known 'hub' instance, typed with the full RPC + fetch surface. */
export function hub(): ReturnType<typeof getFlowHub> {
  return getFlowHub(env);
}

/** Poll `fn` until `pred` accepts its value; throw with the last value on
 *  timeout so the failure says what the world actually looked like. */
export async function waitFor<T>(
  fn: () => Promise<T>,
  pred: (value: T) => boolean,
  ms = 15_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (pred(value)) return value;
    if (Date.now() > deadline) {
      throw new Error(
        `waitFor timed out; last value: ${JSON.stringify(value)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
