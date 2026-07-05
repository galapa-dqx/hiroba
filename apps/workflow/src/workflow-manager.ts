/**
 * WorkflowManager - Durable Object for coordinating workflow operations.
 *
 * Handles both the news and topics pipelines: the trigger payload carries an
 * `itemType` ('news' | 'topic') selecting which workflow binding to drive. The
 * DO is namespaced per (itemType, itemId) by the caller, so news and topic ids
 * (both 32-char hex) never collide.
 *
 * Responsibilities:
 * - Stream SSE progress updates to connected clients
 * - Create/track workflow instances
 * - Poll workflow status and emit events
 *
 * SSE events carry machine-readable pipeline snapshots (see @hiroba/shared's
 * pipeline-state module) computed from D1, not from the workflow instance's
 * output. D1 is the ground truth: image rows are shared across topics, so
 * progress can be advanced by a different item's workflow — and a client that
 * connects after everything finished still gets a terminal event.
 */

import { DurableObject } from 'cloudflare:workers';

import { computeSnapshot, createDb } from '@hiroba/db';
import {
  describeSnapshot,
  isSnapshotSettled,
  type SSEEvent,
  type StateSnapshot,
} from '@hiroba/shared';

import type { Env, ItemType, WorkflowBinding } from './types';

type Active = { instanceId: string; itemType: ItemType };

export class WorkflowManager extends DurableObject<Env> {
  /** Track active workflow instances by item ID. */
  private activeWorkflows = new Map<string, Active>();

  private workflowFor(itemType: ItemType): WorkflowBinding<{ itemId: string }> {
    return itemType === 'topic'
      ? this.env.TOPICS_WORKFLOW
      : this.env.NEWS_WORKFLOW;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/sse') {
      return this.handleSSE(url);
    }
    if (url.pathname === '/trigger' && request.method === 'POST') {
      return this.handleTrigger(request);
    }
    if (url.pathname === '/status') {
      const itemId = url.searchParams.get('itemId');
      if (!itemId)
        return Response.json({ error: 'itemId required' }, { status: 400 });
      return this.handleStatus(itemId);
    }
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  /**
   * Handle SSE connection — streams pipeline snapshots for a (item, language)
   * pair as server-sent events, closing with a terminal complete/error event.
   */
  private handleSSE(url: URL): Response {
    const itemId = url.searchParams.get('itemId');
    if (!itemId) {
      return new Response('itemId query param required', { status: 400 });
    }
    const language = url.searchParams.get('language') ?? 'en';

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: SSEEvent) => {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
          );
        };

        // Item type: from the active workflow when there is one, else from the
        // caller (the proxy routes know which pipeline they front).
        const active = this.activeWorkflows.get(itemId);
        const itemType: ItemType =
          active?.itemType ??
          (url.searchParams.get('itemType') === 'topic' ? 'topic' : 'news');

        const db = createDb(this.env.DB);

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
          this.activeWorkflows.delete(itemId);
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

          if (!active) {
            // Unsettled but nothing running here (e.g. the DO restarted, or a
            // workflow died without settling its states) — nothing to wait on.
            send({ type: 'error', error: 'No active workflow' });
            controller.close();
            return;
          }

          const workflow = this.workflowFor(active.itemType);
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

            const instance = await workflow.get(active.instanceId);
            const status = await instance.status();
            if (
              status.status === 'complete' ||
              status.status === 'errored' ||
              status.status === 'terminated'
            ) {
              // The workflow is finished; whatever the snapshot says now is
              // all it will ever say (errored workflows settle their states in
              // their mark-failed step before reaching this point).
              snapshot = await computeSnapshot(db, itemType, itemId, language);
              emit(snapshot);
              finish(snapshot);
              return;
            }
          }

          this.activeWorkflows.delete(itemId);
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

  /** Handle workflow trigger request. */
  private async handleTrigger(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      itemId: string;
      itemType?: ItemType;
    };
    const { itemId } = body;
    const itemType: ItemType = body.itemType ?? 'news';

    if (!itemId) {
      return Response.json({ error: 'itemId required' }, { status: 400 });
    }

    const workflow = this.workflowFor(itemType);

    // Skip if already processing.
    const existing = this.activeWorkflows.get(itemId);
    if (existing) {
      const instance = await workflow.get(existing.instanceId);
      const status = await instance.status();
      if (status.status === 'running' || status.status === 'queued') {
        return Response.json({
          status: 'already_processing',
          instanceId: existing.instanceId,
        });
      }
    }

    const instance = await workflow.create({ params: { itemId } });
    this.activeWorkflows.set(itemId, { instanceId: instance.id, itemType });
    return Response.json({ status: 'started', instanceId: instance.id });
  }

  /** Handle status request. */
  private async handleStatus(itemId: string): Promise<Response> {
    const active = this.activeWorkflows.get(itemId);
    if (!active) return Response.json({ status: 'idle' });

    try {
      const instance = await this.workflowFor(active.itemType).get(
        active.instanceId,
      );
      const status = await instance.status();
      return Response.json({
        status: status.status,
        instanceId: active.instanceId,
        output: status.output,
        error: status.error,
      });
    } catch {
      this.activeWorkflows.delete(itemId);
      return Response.json({ status: 'idle' });
    }
  }
}
