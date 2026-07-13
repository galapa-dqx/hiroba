/**
 * React binding for per-item run streams on the list pages: one live stream
 * per item — re-triggering a row closes its previous consumer instead of
 * stacking a second EventSource (subscribeItemRun reconnects by design, so an
 * orphaned stream would keep polling the hub forever) — and everything closes
 * on unmount.
 */

import { useEffect, useRef } from 'react';

import type { ItemFlowType } from '@hiroba/flows';

import { subscribeItemRun, type ItemRunHandlers } from './flow-stream';

/** Returns a follow(itemType, itemId, handlers) that owns the streams. */
export function useItemRunStreams(): (
  itemType: ItemFlowType,
  itemId: string,
  handlers: ItemRunHandlers,
) => void {
  const streams = useRef(new Map<string, () => void>());

  useEffect(() => {
    const owned = streams.current;
    return () => {
      for (const stop of owned.values()) stop();
      owned.clear();
    };
  }, []);

  return (itemType, itemId, handlers) => {
    const key = `${itemType}:${itemId}`;
    streams.current.get(key)?.();
    streams.current.set(key, subscribeItemRun(itemType, itemId, handlers));
  };
}
