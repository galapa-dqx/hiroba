/**
 * Domain SSE stream: machine-readable pipeline snapshots for a
 * (item, language) pair, computed from D1 (see @hiroba/shared's
 * pipeline-state module), not from run output. D1 is the ground truth: image
 * rows are shared across topics, so progress can be advanced by a different
 * item's run — and a client that connects after everything finished still
 * gets a terminal event. The stream self-heals: an unsettled item with no
 * active run is started via hub.start.
 *
 * A plain route (DQX-26): dedup lives in the hub, and everything here reads
 * global state (D1 + the hub), so no DO-local coordination is needed.
 */

import { computeSnapshot, createDb } from '@hiroba/db';
import { getFlowHub, isActiveStatus } from '@hiroba/flow/hub';
import {
  describeSnapshot,
  isSnapshotSettled,
  type SSEEvent,
  type StateSnapshot,
} from '@hiroba/shared';

import { flowStart, parseItemType } from './item-flows';
import type { Env } from './types';

/**
 * Handle an SSE connection — streams pipeline snapshots for a
 * (item, language) pair as server-sent events, closing with a terminal
 * complete/error event.
 */
export function domainSSE(env: Env, url: URL): Response {
  const itemId = url.searchParams.get('itemId');
  if (!itemId) {
    return new Response('itemId query param required', { status: 400 });
  }
  const language = url.searchParams.get('language') ?? 'en';
  const itemType = parseItemType(url.searchParams.get('itemType'));

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start: async (controller) => {
      const send = (event: SSEEvent) => {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };

      const db = createDb(env.DB);

      // Emit snapshots only when they change; finish with complete when the
      // article itself made it (failed images degrade, they don't block),
      // error when a prerequisite failed.
      let lastSent: string | null = null;
      const emit = (snapshot: StateSnapshot) => {
        const encoded = JSON.stringify(snapshot);
        if (encoded === lastSent) return;
        lastSent = encoded;
        send({ type: 'state', snapshot });
      };
      const finish = (snapshot: StateSnapshot) => {
        if (snapshot.article === 'done' && snapshot.translation === 'done') {
          send({ type: 'complete' });
        } else {
          send({ type: 'error', error: describeSnapshot(snapshot) });
        }
        controller.close();
      };

      try {
        // Initial snapshot — a client connecting after the pipeline already
        // settled gets its terminal event immediately.
        let snapshot = await computeSnapshot(db, itemType, itemId, language);
        emit(snapshot);
        if (isSnapshotSettled(snapshot)) {
          finish(snapshot);
          return;
        }

        // Unsettled: make sure a run is driving the item. The hub attaches
        // to a run already in flight (the page's fire-and-forget trigger
        // usually won this race) or starts one — the stream is self-healing,
        // so viewing an unprocessed article kicks its pipeline off. A client
        // is actively watching an unsettled article, so `force` past the
        // re-trigger cooldown (which guards degraded *settled* pages) and
        // `probe` a stale-looking active run before attaching to it.
        const { flow, params } = flowStart(itemType, itemId);
        let runId: string | null = null;
        try {
          const result = await getFlowHub(env).start(flow, params, {
            force: true,
            probe: true,
          });
          if (!result.throttled) runId = result.runId;
        } catch (error) {
          console.error('Failed to start workflow from SSE:', error);
        }
        if (!runId) {
          send({ type: 'error', error: 'Could not start workflow' });
          controller.close();
          return;
        }

        const pollInterval = 1000;
        const maxPolls = 300; // 5 minutes

        for (let i = 0; i < maxPolls; i++) {
          await new Promise((resolve) => setTimeout(resolve, pollInterval));

          snapshot = await computeSnapshot(db, itemType, itemId, language);
          emit(snapshot);
          if (isSnapshotSettled(snapshot)) {
            finish(snapshot);
            return;
          }

          const run = await getFlowHub(env).getRun(runId);
          if (!run || !isActiveStatus(run.status)) {
            // The run is finished (or gone); whatever the snapshot says now
            // is all it will ever say (a failed run settles its states in
            // its onFailure hook before reaching this point).
            snapshot = await computeSnapshot(db, itemType, itemId, language);
            emit(snapshot);
            finish(snapshot);
            return;
          }
        }

        send({ type: 'error', error: 'Workflow timeout' });
        controller.close();
      } catch (error) {
        console.error('Error streaming workflow status:', error);
        send({ type: 'error', error: 'Polling failed' });
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
